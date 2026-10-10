// 把網頁和最新的 data/deals.json 推到 GitHub 的 gh-pages 分支（GitHub Pages 從這個分支提供網頁）。
// gh-pages 每次都只有一個 commit，不會讓 repo 越長越大；程式碼留在 main 分支。
// commit 是用暫時的 index 在這個 repo 裡直接組出來的，不會動到工作目錄，推送也沿用這個 repo 的 Git 憑證設定。

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SITE_FILES = ['index.html', 'app.js', 'style.css', 'data/deals.json'];

export async function publish(log = console.log) {
  const git = async (args, env = {}, input) => {
    const child = run('git', args, { cwd: ROOT, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } });
    if (input !== undefined) child.child.stdin.end(input);
    return (await child).stdout.trim();
  };

  try {
    await git(['remote', 'get-url', 'origin']);
  } catch {
    log('尚未設定 GitHub（git remote origin），略過上傳');
    return false;
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), '711-radar-index-'));
  try {
    const env = { GIT_INDEX_FILE: path.join(tmp, 'index') };
    await git(['read-tree', '--empty'], env);
    for (const f of SITE_FILES) {
      const blob = await git(['hash-object', '-w', f]);
      await git(['update-index', '--add', '--cacheinfo', `100644,${blob},${f}`], env);
    }
    const empty = await git(['hash-object', '-w', '--stdin'], {}, '');
    await git(['update-index', '--add', '--cacheinfo', `100644,${empty},.nojekyll`], env);
    const tree = await git(['write-tree'], env);
    const message = `更新特價資料 ${new Date().toLocaleString('zh-TW', { hour12: false })}`;
    const commit = await git(['commit-tree', tree, '-m', message]);
    await git(['push', '-q', '--force', 'origin', `${commit}:refs/heads/gh-pages`]);
    log('已上傳到 GitHub Pages（gh-pages 分支）');
    return true;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
