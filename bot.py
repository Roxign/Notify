import json
import logging
import os
import re
import socket
import sys
import tempfile
import time
import threading
import subprocess
from concurrent.futures import ThreadPoolExecutor
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Dict, Optional, Set, Tuple

import requests as http_requests
from flask import Flask, request, abort
from linebot.v3 import WebhookHandler
from linebot.v3.exceptions import InvalidSignatureError
from linebot.v3.messaging import (
    ApiClient, Configuration, MessagingApi,
    PushMessageRequest, ReplyMessageRequest, SetWebhookEndpointRequest,
    TestWebhookEndpointRequest, TextMessage,
)
from linebot.v3.webhooks import MessageEvent, TextMessageContent

from selenium import webdriver
from selenium.common.exceptions import NoSuchElementException, TimeoutException
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

# ── Config ────────────────────────────────────────────────────────────────────
# Secrets live in .env next to this file (git-ignored); see .env.example.

BASE_DIR = Path(__file__).resolve().parent


def _load_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_env(BASE_DIR / ".env")

LINE_BOT_TOKEN = os.environ.get("LINE_BOT_TOKEN", "")
LINE_BOT_SECRET = os.environ.get("LINE_BOT_SECRET", "")
DEV_USER_IDS = [u.strip() for u in os.environ.get("DEV_USER_IDS", "").split(",") if u.strip()]

# Log file and tracking state (kept off OneDrive)
BOT_HOME = Path(os.environ.get("BOT_HOME", r"E:\line-bot"))
LOG_FILE = BOT_HOME / "bot.log"
STATE_FILE = BOT_HOME / "tracking.json"
TASK_NAME = "LINE報單追蹤bot"

# ── Constants ─────────────────────────────────────────────────────────────────

SITE_URL = "https://portal.sw.nat.gov.tw/APGQ/LoginFree?request_locale=zh_TW&breadCrumbs=JTdCJTIyYnJlYWRDcnVtYnMlMjIlM0ElNUIlN0IlMjJuYW1lJTIyJTNBJTIyJUU1JTg1JThEJUU4JUFEJTg5JUU2JTlGJUE1JUU4JUE5JUE2JUU2JTlDJThEJUU1JThCJTk5JTIyJTJDJTIydXJsJTIyJTNBJTIyJTIyJTdEJTJDJTdCJTIybmFtZSUyMiUzQSUyMiVFOSU4MCVCMiVFNSU4RiVBMyVFOSU4MCU5QSVFOSU5NyU5QyVFNiVCNSU4MSVFNyVBOCU4QiUyMiUyQyUyMnVybCUyMiUzQSUyMmNoYW5nZU1lbnVVcmwyKCclRTklODAlQjIlRTUlOEYlQTMlRTklODAlOUElRTklOTclOUMlRTYlQjUlODElRTclQTglOEInJTJDJ0FQR1FfMicpJTIyJTdEJTJDJTdCJTIybmFtZSUyMiUzQSUyMihHQjMwMSklRTklODAlQjIlRTUlOEYlQTMlRTUlQTAlQjElRTUlOTYlQUUlRTklODAlOUElRTklOTclOUMlRTYlQjUlODElRTclQTglOEIlRTYlOUYlQTUlRTglQTklQTIlMjIlMkMlMjJ1cmwlMjIlM0ElMjJvcGVuTWVudSgnJTJGQVBHUSUyRkdCMzAxJyklMjIlN0QlMkMlN0IlN0QlMkMlN0IlN0QlNUQlMkMlMjJwYXRoVXJsJTIyJTNBJTIyJTIzTUVOVV9BUEdRJTJDJTIzTUVOVV9BUEdRXzIlMkMlMkZBUEdRJTJGR0IzMDElMjIlN0Q="
SEARCH_TIMEOUT = 30
NEXT_TIMEOUT = 10
SEARCH_INTERVAL = 60  # seconds
TUNNEL_CHECK_INTERVAL = 60  # seconds

PORT = 5000
NGROK_API_URL = "http://localhost:4040/api/tunnels"
_ngrok_url: Optional[str] = None
_ngrok_proc: Optional[subprocess.Popen] = None

# Child processes (ngrok, chromedriver) must not pop up console windows under pythonw
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

log = logging.getLogger("bot")

# ── Flask / Line SDK setup ────────────────────────────────────────────────────

app = Flask(__name__)
handler = WebhookHandler(LINE_BOT_SECRET)
_line_config = Configuration(access_token=LINE_BOT_TOKEN)
_executor = ThreadPoolExecutor(max_workers=4)

# ── Helpers ───────────────────────────────────────────────────────────────────

def _push_text(to: str, text: str) -> None:
    with ApiClient(_line_config) as api_client:
        MessagingApi(api_client).push_message(
            PushMessageRequest(to=to, messages=[TextMessage(text=text)])
        )


def _reply_text(reply_token: str, text: str) -> None:
    with ApiClient(_line_config) as api_client:
        MessagingApi(api_client).reply_message(
            ReplyMessageRequest(reply_token=reply_token, messages=[TextMessage(text=text)])
        )


def _push_target(event: MessageEvent) -> str:
    src = event.source
    if src.type == "group":
        return src.group_id
    if src.type == "room":
        return src.room_id
    return src.user_id


def parse_query(text: str) -> Tuple[Optional[str], Optional[str]]:
    vsl = re.search(r'通關\s*(\S+)', text)
    mft = re.search(r'艙號\s*(\S+)', text)
    if vsl and mft:
        return vsl.group(1), mft.group(1)
    nums = re.findall(r'[A-Za-z0-9]+', text)
    if len(nums) >= 2:
        return nums[0], nums[1]
    return None, None


# Registry: (vsl_reg_no, mft_no) -> {"subscribers": set of push_to IDs, "latest_msg": str|None}
_poll_registry: Dict = {}
_registry_lock = threading.Lock()
_search_lock = threading.Lock()   # only one Chrome session at a time


def _save_state() -> None:
    """Persist tracked containers so tracking resumes after a restart. Caller holds _registry_lock."""
    data = {f"{vsl}|{mft}": sorted(e["subscribers"]) for (vsl, mft), e in _poll_registry.items()}
    try:
        tmp = STATE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        tmp.replace(STATE_FILE)
    except OSError as exc:
        log.warning(f"[state] Could not save tracking state: {exc}")


def _resume_tracking() -> None:
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return
    except Exception as exc:
        log.warning(f"[state] Could not read {STATE_FILE}: {exc}")
        return
    for key_str, subs in data.items():
        vsl_reg_no, mft_no = key_str.split("|", 1)
        with _registry_lock:
            _poll_registry[(vsl_reg_no, mft_no)] = {"subscribers": set(subs), "latest_msg": None}
        _executor.submit(_poll_until_released, vsl_reg_no, mft_no)
    if data:
        log.info(f"[state] Resumed {len(data)} tracking task(s) from before the restart")


def _push_to_subscribers(key: tuple, msg: str) -> None:
    """Update latest_msg and push to all current subscribers."""
    with _registry_lock:
        entry = _poll_registry.get(key)
        if entry is None:
            return
        entry["latest_msg"] = msg
        subs = set(entry["subscribers"])
    for sub in subs:
        try:
            _push_text(sub, msg)
        except Exception as exc:
            log.warning(f"[line] Push to {sub} failed: {exc}")


def _poll_until_released(vsl_reg_no: str, mft_no: str) -> None:
    """Poll every 60 s; push to all subscribers when new records appear; stop on 放行."""
    key = (vsl_reg_no, mft_no)
    prev_snapshot: Optional[frozenset] = None
    try:
        while True:
            try:
                found, msg, records = search_container(vsl_reg_no, mft_no)
            except Exception as exc:
                _push_to_subscribers(key, f"系統錯誤：{exc}")
                break

            if not found:
                if prev_snapshot is None:   # first attempt — always report and stop
                    _push_to_subscribers(key, msg)
                    break
                # transient failure after a prior success — skip this cycle
                time.sleep(SEARCH_INTERVAL)
                continue

            snapshot = frozenset(tuple(r) for r in records)
            if snapshot != prev_snapshot:   # new / changed states
                _push_to_subscribers(key, msg)
                prev_snapshot = snapshot

            if "✅ 已放行" in msg:
                break

            time.sleep(SEARCH_INTERVAL)
    finally:
        with _registry_lock:
            _poll_registry.pop(key, None)
            _save_state()

# ── Webhook ───────────────────────────────────────────────────────────────────

@app.route("/callback", methods=["POST"])
def callback():
    signature = request.headers.get("X-Line-Signature", "")
    body = request.get_data(as_text=True)
    try:
        handler.handle(body, signature)
    except InvalidSignatureError:
        abort(400)
    return "OK"


@handler.add(MessageEvent, message=TextMessageContent)
def handle_message(event: MessageEvent) -> None:
    text = event.message.text.strip()
    push_to = _push_target(event)

    # ── 狀態 command: report all tasks this user/group is subscribed to ────
    if "狀態" in text:
        with _registry_lock:
            entries = [
                (k, v["latest_msg"])
                for k, v in _poll_registry.items()
                if push_to in v["subscribers"]
            ]
        if not entries:
            _reply_text(event.reply_token, "目前沒有追蹤中的貨櫃")
        else:
            parts = []
            for (vsl, mft), latest in entries:
                parts.append(latest or f"海關{vsl}\n艙號{mft}\n⏳ 搜尋中...")
            _reply_text(event.reply_token, "\n───\n".join(parts))
        return

    # ── New tracking request ───────────────────────────────────────────────
    vsl_reg_no, mft_no = parse_query(text)
    if not vsl_reg_no or not mft_no:
        _reply_text(
            event.reply_token,
            "格式錯誤，範例：\n通關151197\n艙號0169",
        )
        return

    key = (vsl_reg_no, mft_no)
    with _registry_lock:
        if key in _poll_registry:
            _poll_registry[key]["subscribers"].add(push_to)
            latest = _poll_registry[key]["latest_msg"] or f"海關{vsl_reg_no}\n艙號{mft_no}\n⏳ 搜尋中..."
            already_tracking = True
        else:
            _poll_registry[key] = {"subscribers": {push_to} | set(DEV_USER_IDS), "latest_msg": None}
            already_tracking = False
        _save_state()

    if already_tracking:
        _reply_text(
            event.reply_token,
            f"✅ 已加入追蹤\n海關：{vsl_reg_no}\n艙號：{mft_no}\n目前狀態:\n{latest}",
        )
    else:
        # Reply immediately (uses reply token = free); polling loop starts afterwards.
        _reply_text(
            event.reply_token,
            f"🔍 已開始追蹤報單狀態\n海關：{vsl_reg_no}\n艙號：{mft_no}\n每分鐘自動刷新，放行後停止",
        )
        _executor.submit(_poll_until_released, vsl_reg_no, mft_no)

# ── ngrok ─────────────────────────────────────────────────────────────────────

def _find_tunnel() -> Optional[str]:
    """Public https URL of a running ngrok tunnel to PORT, if any."""
    try:
        resp = http_requests.get(NGROK_API_URL, timeout=2)
        for tunnel in resp.json().get("tunnels", []):
            if tunnel.get("proto") == "https" and tunnel.get("config", {}).get("addr", "").endswith(f":{PORT}"):
                return tunnel["public_url"]
    except Exception:
        pass
    return None


def start_ngrok() -> Optional[subprocess.Popen]:
    """Reuse a running tunnel to PORT, or start ngrok. Returns the process if this call started it."""
    global _ngrok_url
    url = _find_tunnel()
    if url:
        _ngrok_url = url
        log.info(f"[ngrok] Reusing running tunnel → {url}")
        return None

    proc = subprocess.Popen(
        ["ngrok", "http", str(PORT)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=NO_WINDOW,
    )
    log.info(f"[ngrok] Started (pid {proc.pid}), waiting for tunnel...")
    for _ in range(15):
        time.sleep(1)
        url = _find_tunnel()
        if url:
            _ngrok_url = url
            log.info(f"[ngrok] Tunnel → {url}")
            return proc
    proc.terminate()
    raise RuntimeError("Failed to retrieve ngrok URL. Ensure ngrok is installed and the network is up.")


def update_line_webhook(base_url: str) -> bool:
    """Point the LINE channel's webhook at base_url/callback and verify it. Returns True on success."""
    endpoint = f"{base_url}/callback"
    try:
        with ApiClient(_line_config) as api_client:
            api = MessagingApi(api_client)
            current = api.get_webhook_endpoint()
            if current.endpoint != endpoint:
                api.set_webhook_endpoint(SetWebhookEndpointRequest(endpoint=endpoint))
                log.info(f"[line] Webhook URL updated: {current.endpoint} → {endpoint}")
            else:
                log.info(f"[line] Webhook URL already set → {endpoint}")
            if not current.active:
                log.warning("[line] 'Use webhook' is OFF in the LINE Developers console; messages won't arrive")
            result = api.test_webhook_endpoint(TestWebhookEndpointRequest(endpoint=endpoint))
        if result.success:
            log.info("[line] Webhook test OK")
            return True
        log.warning(f"[line] Webhook test failed: {result.status_code} {result.reason} {result.detail}")
    except Exception as exc:
        log.warning(f"[line] Could not update webhook: {exc}")
    return False


def _keep_tunnel_alive(flask_thread: threading.Thread) -> None:
    """Main loop: restart ngrok if its tunnel disappears, and keep LINE's webhook URL in sync."""
    global _ngrok_proc
    synced_url: Optional[str] = None
    while True:
        if not flask_thread.is_alive():
            raise RuntimeError("Flask server stopped")
        url = _find_tunnel()
        if url is None:
            if _ngrok_proc and _ngrok_proc.poll() is None:
                _ngrok_proc.terminate()
            try:
                _ngrok_proc = start_ngrok()
                url = _ngrok_url
            except RuntimeError as exc:
                log.warning(f"[ngrok] {exc} Retrying...")
        if url and url != synced_url and update_line_webhook(url):
            synced_url = url
        time.sleep(TUNNEL_CHECK_INTERVAL if url and url == synced_url else 10)

# ── Search ────────────────────────────────────────────────────────────────────

def search_container(vsl_reg_no: str, mft_no: str) -> Tuple[bool, str, list]:
    with _search_lock:
        for proc_cust_cd in ("", "BE"):
            driver = None
            try:
                options = Options()
                options.add_argument("--headless")
                service = Service(popen_kw={"creation_flags": NO_WINDOW})
                driver = webdriver.Chrome(service=service, options=options)
                driver.implicitly_wait(5)
                driver.get(SITE_URL)

                wait = WebDriverWait(driver, SEARCH_TIMEOUT)
                for by, value in [
                    (By.NAME, "declCustCd"), (By.NAME, "procCustCd"),
                    (By.NAME, "vslRegNo"), (By.NAME, "mftNo"), (By.ID, "GB301_SEARCH"),
                ]:
                    wait.until(EC.presence_of_element_located((by, value)))
                wait.until(EC.element_to_be_clickable((By.ID, "GB301_SEARCH")))
                time.sleep(2)

                driver.find_element(By.NAME, "declCustCd").send_keys("AT")
                driver.find_element(By.NAME, "procCustCd").send_keys(proc_cust_cd)
                driver.find_element(By.NAME, "vslRegNo").send_keys(vsl_reg_no)
                driver.find_element(By.NAME, "mftNo").send_keys(mft_no)
                driver.find_element(By.ID, "GB301_SEARCH").click()
                time.sleep(2)

                info = WebDriverWait(driver, NEXT_TIMEOUT).until(
                    EC.presence_of_element_located((By.XPATH, '//*[@id="detail_grid2"]/div[3]/span[2]'))
                )
                match = re.search(r"共\s*(\d+)\s*筆", info.text)
                total_records = int(match.group(1)) if match else 0
                if total_records == 0:
                    continue

                records, rl_index, seen = [], -1, set()
                while True:
                    try:
                        tbody = driver.find_element(By.XPATH, '//*[@id="detail_grid2"]/div[2]/table/tbody')
                        for tr in tbody.find_elements(By.TAG_NAME, "tr"):
                            cols = [td.text.strip() for td in tr.find_elements(By.TAG_NAME, "td")]
                            if not cols or not cols[0].isdigit() or tuple(cols) in seen:
                                continue
                            seen.add(tuple(cols))
                            records.append(cols)
                            if "RL 放行" in cols and rl_index == -1:
                                try:
                                    rl_index = int(cols[0])
                                except ValueError:
                                    pass

                        if not records:
                            break

                        first_key = records[0][0]
                        driver.find_element(By.XPATH, '//*[@id="detail_grid2"]/div[3]/a[3]').click()
                        time.sleep(1)

                        new_tbody = driver.find_element(By.XPATH, '//*[@id="detail_grid2"]/div[2]/table/tbody')
                        new_rows = [
                            [td.text.strip() for td in tr.find_elements(By.TAG_NAME, "td")]
                            for tr in new_tbody.find_elements(By.TAG_NAME, "tr")
                        ]
                        new_rows = [r for r in new_rows if r and r[0].isdigit()]
                        if not new_rows or new_rows[0][0] == first_key:
                            break
                    except (NoSuchElementException, IndexError):
                        break

                if not records:
                    continue

                msg = f"海關{vsl_reg_no}\n艙號{mft_no}\n"
                if len(records) < total_records:
                    msg += f"注意: 只找到{len(records)}/{total_records}筆資料\n"
                if rl_index >= 0:
                    rl_record = next((r for r in records if int(r[0]) == rl_index), None)
                    relevant = [r for r in records if int(r[0]) < rl_index][-2:]
                    if rl_record:
                        relevant.append(rl_record)
                    msg += "最新狀態:\n" + "".join(f"{r[1]} | {r[2]}\n" for r in relevant)
                    msg += "✅ 已放行 - 追蹤完成"
                else:
                    msg += "最新狀態:\n" + "".join(f"{r[1]} | {r[2]}\n" for r in records[-3:])
                    msg += "⏳ 持續追蹤中..."
                return True, msg, records

            except (TimeoutException, NoSuchElementException):
                continue
            except Exception as exc:
                log.warning(f"[search] {vsl_reg_no}/{mft_no} failed: {exc}")
                return False, f"海關{vsl_reg_no}\n艙號{mft_no}\n錯誤: 系統異常\n追蹤程序結束", []
            finally:
                if driver:
                    driver.quit()

        return False, f"海關{vsl_reg_no}\n艙號{mft_no}\n錯誤: 查無資料\n追蹤程序結束", []

# ── Background task (Windows Task Scheduler) ──────────────────────────────────

def _install_task() -> None:
    """Run this bot hidden (pythonw) at Windows logon, restarting it if it crashes."""
    user = f"{os.environ.get('USERDOMAIN', '')}\\{os.environ['USERNAME']}"
    pythonw = Path(sys.executable).with_name("pythonw.exe")
    esc = lambda s: str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    xml = f"""<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>LINE 報單追蹤 bot（Flask + ngrok）：登入 Windows 後在背景執行，並自動更新 LINE webhook 網址</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{esc(user)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{esc(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{esc(pythonw)}</Command>
      <Arguments>"{esc(BASE_DIR / 'bot.py')}"</Arguments>
      <WorkingDirectory>{esc(BASE_DIR)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"""
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "task.xml"
        path.write_text(xml, encoding="utf-16")
        subprocess.run(["schtasks", "/Create", "/TN", TASK_NAME, "/XML", str(path), "/F"], check=True)
    print(f"已建立排程「{TASK_NAME}」：登入 Windows 時自動在背景啟動，當掉會在 1 分鐘後重啟。")
    print(f"現在就啟動：schtasks /Run /TN {TASK_NAME}")


def _setup_logging() -> None:
    BOT_HOME.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("[%(asctime)s] %(message)s", "%Y-%m-%d %H:%M:%S")
    handlers: list = [RotatingFileHandler(LOG_FILE, maxBytes=1_000_000, backupCount=3, encoding="utf-8")]
    if sys.stdout is not None:   # pythonw has no console
        handlers.append(logging.StreamHandler(sys.stdout))
    for h in handlers:
        h.setFormatter(fmt)
        log.addHandler(h)
    log.setLevel(logging.INFO)
    # Exceptions in threads would otherwise vanish under pythonw
    threading.excepthook = lambda a: log.error(f"[{a.thread.name}] crashed", exc_info=(a.exc_type, a.exc_value, a.exc_traceback))


def _run_flask() -> None:
    logging.getLogger("werkzeug").setLevel(logging.ERROR)   # suppress Flask request noise in background mode
    app.run(host="0.0.0.0", port=PORT, use_reloader=False)


def _port_in_use(port: int) -> bool:
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


if __name__ == "__main__":
    if "--install-task" in sys.argv:
        _install_task()
        sys.exit(0)
    if "--remove-task" in sys.argv:
        subprocess.run(["schtasks", "/Delete", "/TN", TASK_NAME, "/F"], check=True)
        sys.exit(0)

    _setup_logging()
    if not LINE_BOT_TOKEN or not LINE_BOT_SECRET:
        log.error(f"[main] LINE_BOT_TOKEN / LINE_BOT_SECRET missing; put them in {BASE_DIR / '.env'}")
        sys.exit(1)
    if _port_in_use(PORT):
        # Another copy is already running (e.g. started by hand); exit 0 so the task doesn't restart-loop
        log.info(f"[main] Port {PORT} is already in use; another bot is probably running. Exiting.")
        sys.exit(0)

    # Start Flask first so LINE's webhook test can reach /callback
    flask_thread = threading.Thread(target=_run_flask, daemon=True, name="flask")
    flask_thread.start()
    log.info(f"[flask] Running on port {PORT}")
    _resume_tracking()

    exit_code = 0
    try:
        _keep_tunnel_alive(flask_thread)
    except KeyboardInterrupt:
        log.info("[main] Shutting down...")
    except Exception:
        log.exception("[main] Crashed; the scheduled task will restart the bot")
        exit_code = 1
    finally:
        if _ngrok_proc and _ngrok_proc.poll() is None:
            _ngrok_proc.terminate()
            log.info("[ngrok] Terminated.")
    # Polling threads are blocking; skip waiting for them (state is already on disk)
    os._exit(exit_code)
