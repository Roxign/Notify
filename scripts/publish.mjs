// 把網頁和最新的 data/deals.json 推到 GitHub 的 gh-pages 分支（GitHub Pages 從這個分支提供網頁）。
// gh-pages 每次都只有一個 commit，不會讓 repo 越長越大；程式碼留在 main 分支。

import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SITE_FILES = ['index.html', 'app.js', 'style.css', 'data/deals.json'];

export async function publish(log = console.log) {
  let remote = '';
  try {
    remote = (await run('git', ['remote', 'get-url', 'origin'], { cwd: ROOT })).stdout.trim();
  } catch {
    /* 沒有 remote */
  }
  if (!remote) {
    log('尚未設定 GitHub（git remote origin），略過上傳');
    return false;
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), '711-radar-site-'));
  try {
    for (const f of SITE_FILES) {
      await mkdir(path.dirname(path.join(dir, f)), { recursive: true });
      await cp(path.join(ROOT, f), path.join(dir, f));
    }
    await writeFile(path.join(dir, '.nojekyll'), '');
    const git = (...args) => run('git', args, { cwd: dir, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    await git('init', '-q', '-b', 'gh-pages');
    await git('add', '-A');
    await git('commit', '-q', '-m', `更新特價資料 ${new Date().toLocaleString('zh-TW', { hour12: false })}`);
    await git('push', '-q', '--force', remote, 'gh-pages');
    log('已上傳到 GitHub Pages（gh-pages 分支）');
    return true;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
