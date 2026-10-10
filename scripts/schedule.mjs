// 在 Windows 工作排程器建立 / 移除「每小時查一次」的排程。
// 用法：npm run schedule            建立（或更新）排程
//       npm run schedule -- --remove 移除排程
// 排程只在你登入 Windows 時執行（需要用到你的 Git 憑證），執行時不會跳出視窗。

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TASK_NAME = '7-11商品卡特價雷達';
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');

const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

if (process.argv.includes('--remove')) {
  execFileSync('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], { stdio: 'inherit' });
  process.exit(0);
}

// 從下一個整點開始，每小時一次
const start = new Date();
start.setHours(start.getHours() + 1, 0, 0, 0);
const pad = (n) => String(n).padStart(2, '0');
const startBoundary = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}T${pad(start.getHours())}:00:00`;

const conhost = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'conhost.exe');
const args = `--headless "${process.execPath}" "${path.join(ROOT, 'scripts', 'update.mjs')}"`;

const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>查詢蝦皮上低於面額的 7-11 商品卡並更新 GitHub Pages</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>${startBoundary}</StartBoundary>
      <Repetition>
        <Interval>PT1H</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(conhost)}</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
      <WorkingDirectory>${xmlEscape(ROOT)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;

const dir = mkdtempSync(path.join(os.tmpdir(), '711-radar-task-'));
const file = path.join(dir, 'task.xml');
try {
  writeFileSync(file, `\ufeff${xml}`, 'utf16le');
  execFileSync('schtasks', ['/Create', '/TN', TASK_NAME, '/XML', file, '/F'], { stdio: 'inherit' });
  console.log(`已建立排程「${TASK_NAME}」：從 ${startBoundary.replace('T', ' ')} 開始每小時執行一次。`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
