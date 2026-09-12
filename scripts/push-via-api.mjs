#!/usr/bin/env node
/**
 * 通过 GitHub Git Data API 推送当前分支（直连 github.com 被断时的备用通道，
 * 走 api.github.com）。产生与 git push 完全相同的提交对象，之后 git push 自动为 no-op。
 * 用法：node scripts/push-via-api.mjs [owner/repo] [branch]
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const repo = process.argv[2] ?? 'yinkesi/gptchat';
const branch = process.argv[3] ?? 'main';
const tmp = mkdtempSync(path.join(tmpdir(), 'gptchat-push-'));

const sh = (cmd) => execSync(cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const gh = (route, method, body) => {
  const args = [`gh api repos/${repo}/git/${route}`];
  if (body) {
    const file = path.join(tmp, `req-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify(body));
    args.push(`--method ${method}`, `--input ${file}`);
  }
  return JSON.parse(sh(args.join(' ')));
};

const localHead = sh('git rev-parse HEAD');
const changed = sh(`git diff --name-only origin/${branch}..HEAD`).split('\n').filter(Boolean);
if (changed.length === 0) {
  console.log('[push-api] 本地与远端一致，无需推送');
  process.exit(0);
}
console.log(`[push-api] 待推送 ${changed.length} 个文件 -> ${repo}@${branch}`);

const ref = gh(`ref/heads/${branch}`);
const baseCommit = gh(`commits/${ref.object.sha}`);

const treeItems = [];
for (const file of changed) {
  const status = sh(`git status --porcelain -- "${file}"`).slice(0, 2);
  if (status.startsWith('D')) {
    treeItems.push({ path: file, sha: null, mode: '100644' });
    console.log(`  - 删除 ${file}`);
    continue;
  }
  const content = readFileSync(file);
  const blob = gh('blobs', 'POST', { content: content.toString('base64'), encoding: 'base64' });
  treeItems.push({ path: file, mode: '100644', type: 'blob', sha: blob.sha });
  console.log(`  · ${file}（${content.length} 字节）`);
}

const tree = gh('trees', 'POST', { base_tree: baseCommit.tree.sha, tree: treeItems });
const commit = gh('commits', 'POST', {
  message: sh('git log -1 --pretty=%B'),
  tree: tree.sha,
  parents: [ref.object.sha],
});
gh(`refs/heads/${branch}`, 'PATCH', { sha: commit.sha, force: false });
console.log(`[push-api] 完成：远端 ${branch} -> ${commit.sha.slice(0, 10)}`);
