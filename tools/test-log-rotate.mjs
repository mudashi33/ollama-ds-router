#!/usr/bin/env node
/**
 * test-log-rotate.mjs —— 验证守护进程的日志轮转真的能轮转。
 * 不联网、不碰线上端口（用 8797/8791 和临时目录）。运行：node tools/test-log-rotate.mjs
 *
 * 为什么值得单开一个测试：原来的实现有两个洞，肉眼看不出来 ——
 *   1) 只在启动子进程时检查一次，连着跑几天就再也不轮转；
 *   2) 用 renameSync 换文件，子进程 stdout 句柄还指着改名后的那份，
 *      于是 .1 越写越大、新文件一直是空的（还看不到）。
 * 所以这里既验「轮转发生」，也验「轮转之后继续写没有问题、也没有空洞」。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'router-sup-log-'));
const LOG = path.join(TMP, 'sup.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`);
};

fs.writeFileSync(LOG, 'OLD-LINE-'.repeat(300) + '\n');

const sup = spawn(process.execPath, [path.join(here, 'supervisor.mjs')], {
  cwd: root,
  env: {
    ...process.env,
    ROUTER_PORT: '8797',
    ROUTER_HOST: '127.0.0.1',
    ROUTER_SUPERVISOR_PORT: '8791',
    ROUTER_SUPERVISOR_LOG: LOG,
    // 阈值设成 1KB，让启动时那 3KB 立刻触发轮转
    ROUTER_LOG_MAX_BYTES: '1024',
    ROUTER_LOG_MAX_AGE_DAYS: '0', // 只看大小，避免 CI 里时间不准导致结果漂移
    ROUTER_SUPERVISOR_CHECK_MS: '2000',
    ROUTER_STATS_FILE: path.join(TMP, 'stats.json'),
    ROUTER_MODE_FILE: path.join(TMP, 'mode.json'),
    ROUTER_LOG_FILE: path.join(TMP, 'router.log'),
    DEEPSEEK_BASE: 'http://127.0.0.1:9199',
    DEEPSEEK_API_KEY: 'test-ds',
    OLLAMA_API_KEY: 'test-ol',
    ROUTER_FIRST_BYTE_TIMEOUT_MS: '2000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
sup.stdout.on('data', () => {});
sup.stderr.on('data', () => {});

try {
  await sleep(5000);
  const bak = LOG + '.1';
  const bakOk = fs.existsSync(bak);
  check('超过阈值时生成 .1 备份', bakOk, bakOk ? `${fs.statSync(bak).size}B` : '没有 .1');
  check(
    '.1 里是轮转前的旧内容',
    bakOk && fs.readFileSync(bak, 'utf8').startsWith('OLD-LINE-'),
    bakOk ? fs.readFileSync(bak, 'utf8').slice(0, 16) : '',
  );
  const afterRotate = fs.readFileSync(LOG, 'utf8');
  check('原文件被截断并写了轮转说明', afterRotate.includes('日志轮转'), `${afterRotate.length}B`);

  // 轮转后继续写：句柄要是坏的，这里就不会有新内容
  const before = fs.statSync(LOG).size;
  await fetch('http://127.0.0.1:8797/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
  })
    .then((r) => r.text())
    .catch(() => '');
  await sleep(800);
  const buf = fs.readFileSync(LOG);
  const zeros = [...buf].filter((b) => b === 0).length;
  check('轮转后仍能继续写', buf.length > before, `${before}B → ${buf.length}B`);
  // copytruncate 的经典坑：如果句柄还记着旧偏移，新写入会从旧位置开始，中间留一片 NUL
  check('没有留下空洞（NUL 字节）', zeros === 0, `NUL=${zeros}`);
  check('日志里能看到 router 的输出', buf.toString('utf8').includes('→ deepseek'), '');
} finally {
  sup.kill();
  await sleep(600);
  fs.rmSync(TMP, { recursive: true, force: true });
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} 通过`);
process.exit(bad.length ? 1 : 0);
