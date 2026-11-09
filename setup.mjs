#!/usr/bin/env node
/**
 * setup.mjs —— 一键部署时间路由
 *
 * 做的事：
 *   1. 找 DeepSeek 官方 key（顺序：环境变量 → .env → DSH 的 .credentials.yaml）
 *   2. 只向你要 Ollama 的 key（输入时打星号）
 *   3. 各发一个 max_tokens=1 的真实请求，验证两个 key 都能用
 *   4. 写 .env
 *   5. 在「启动」文件夹放一个自启脚本（开机静默运行，无黑窗口）
 *   6. 立刻把路由拉起来并检查健康
 *   7. 检查 DSH 配置里有没有 time-router 那条路由
 *
 * 用法：
 *   node setup.mjs              正常部署
 *   node setup.mjs --force      验证失败也继续
 *   node setup.mjs --dry-run    只检查、不写文件、不装自启、不启动
 *   node setup.mjs --uninstall  删除自启项（不删除文件和 key）
 *   node setup.mjs --startup-only  只重写「启动」文件夹里的自启脚本（修自启用）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(HERE, '.env');
const LAUNCHER = path.join(HERE, 'run-hidden.vbs');
const STARTUP_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  'Startup',
);
const STARTUP_FILE = path.join(STARTUP_DIR, 'ollama-ds-router.vbs');
const CREDS_FILE = path.join(os.homedir(), '.dsh', '.credentials.yaml');
const DSH_PATCH = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
const HEALTH_URL = 'http://127.0.0.1:8788/_router/status';

const DS = { label: 'DeepSeek 官方', base: 'https://api.deepseek.com', model: 'deepseek-flash' };
const OL = { label: 'Ollama Cloud', base: 'https://ollama.com/v1', model: 'deepseek-v4.1-flash' };

const argv = new Set(process.argv.slice(2));
const DRY = argv.has('--dry-run');
const FORCE = argv.has('--force');
const UNINSTALL = argv.has('--uninstall');
const STARTUP_ONLY = argv.has('--startup-only');

const say = (s = '') => console.log(s);
const step = (n, s) => say(`\n[${n}] ${s}`);
const ok = (s) => say(`    ✓ ${s}`);
const bad = (s) => say(`    ✗ ${s}`);
const warn = (s) => say(`    ! ${s}`);

// ------------------------------------------------------------------ 输入

function ask(prompt, { secret = false } = {}) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || !secret) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(prompt, (a) => {
        rl.close();
        resolve(a.trim());
      });
      return;
    }
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(buf.trim());
          return;
        }
        if (ch === '\u0003') {
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          if (buf.length) {
            buf = buf.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        if (ch >= ' ') {
          buf += ch;
          process.stdout.write('*');
        }
      }
    };
    stdin.on('data', onData);
  });
}

// ------------------------------------------------------------------ 找 key

function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function findDeepSeekKey() {
  if (process.env.DEEPSEEK_API_KEY) return { key: process.env.DEEPSEEK_API_KEY, from: '环境变量' };
  const env = readEnvFile(ENV_FILE);
  if (env.DEEPSEEK_API_KEY) return { key: env.DEEPSEEK_API_KEY, from: '.env' };
  try {
    const text = fs.readFileSync(CREDS_FILE, 'utf8');
    const m = text.match(/^\s*DEEPSEEK_API_KEY\s*:\s*(\S+)\s*$/m);
    if (m) return { key: m[1], from: 'DSH 凭证库' };
  } catch {
    /* 没有就算了 */
  }
  return null;
}

const mask = (k) => (k ? `${k.slice(0, 6)}…${k.slice(-4)}（${k.length} 字符）` : '(空)');

// ------------------------------------------------------------------ 验证

async function verifyChat(target, key) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${target.base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: target.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const text = await r.text();
    const ms = Date.now() - t0;
    if (r.ok) return { ok: true, detail: `HTTP ${r.status}，${ms}ms，model=${target.model}` };
    return { ok: false, detail: `HTTP ${r.status}：${text.slice(0, 180).replace(/\s+/g, ' ')}` };
  } catch (err) {
    return { ok: false, detail: `连不上：${err?.name === 'TimeoutError' ? '30s 超时' : err?.message || err}` };
  }
}

// ------------------------------------------------------------------ 落盘

function upsertEnv(file, kv) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  const seen = new Set();
  const out = lines.map((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && m[1] in kv) {
      seen.add(m[1]);
      return `${m[1]}=${kv[m[1]]}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(kv)) if (!seen.has(k)) out.push(`${k}=${v}`);
  fs.writeFileSync(`${file}`, `${out.join('\n').replace(/\n+$/, '')}\n`, 'utf8');
}

/** 计划任务 Ollama-DS-Router 是否存在（登录即起 + 守护循环，比「启动」文件夹更稳） */
function hasScheduledTask() {
  try {
    execFileSync('schtasks', ['/query', '/tn', 'Ollama-DS-Router'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 装自启。如果已经有计划任务，就不再往「启动」文件夹塞脚本——否则登录时会起两份，
 * 两份抢 8788 端口（后来者发现端口被占就退出，等于白起）。
 * 返回 'task' | 'startup'。
 */
function installStartup() {
  if (hasScheduledTask()) {
    if (fs.existsSync(STARTUP_FILE)) {
      fs.unlinkSync(STARTUP_FILE); // 老版本留下的，删掉防重复
      return 'task-cleaned';
    }
    return 'task';
  }
  // 注意：绝对不要在生成的 .vbs 里写中文。wscript 按 ANSI(GBK) 读取脚本，
  // UTF-8 的中文注释会变成乱码字节，把后面的语句吃掉（曾导致 Run 命令被截断）。
  const body = [
    "' Generated by setup.mjs - starts the DeepSeek/Ollama time router at logon",
    `' generated ${new Date().toISOString()}`,
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run "wscript.exe ""${LAUNCHER}""", 0, False`,
    '',
  ].join('\r\n');
  fs.mkdirSync(STARTUP_DIR, { recursive: true });
  fs.writeFileSync(STARTUP_FILE, body, 'utf8');
  return 'startup';
}

function launchRouter() {
  spawn('wscript.exe', [LAUNCHER], { cwd: HERE, detached: true, stdio: 'ignore' }).unref();
}

async function waitHealth(ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return await r.json();
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

// ------------------------------------------------------------------ 主流程

async function main() {
  say('DeepSeek ⇄ Ollama 时间路由 —— 一键部署');
  say(`目录：${HERE}`);
  if (DRY) say('（dry-run：只检查，不写文件、不装自启、不启动）');

  const [nMajor, nMinor] = process.versions.node.split('.').map(Number);
  if (nMajor < 20 || (nMajor === 20 && nMinor < 6)) {
    warn(`当前 Node ${process.versions.node} 偏旧：--env-file 要 20.6+，静默启动可能起不来`);
  }

  if (STARTUP_ONLY) {
    const how = installStartup();
    if (how === 'startup') ok(`已重写自启项：${STARTUP_FILE}`);
    else ok(`已检测到计划任务 Ollama-DS-Router，跳过「启动」文件夹${how === 'task-cleaned' ? '（并删掉旧的 vbs）' : ''}`);
    return;
  }

  if (UNINSTALL) {
    if (fs.existsSync(STARTUP_FILE)) {
      fs.unlinkSync(STARTUP_FILE);
      ok(`已删除自启项：${STARTUP_FILE}`);
    } else {
      warn('没有找到自启项，无需删除');
    }
    say('\n代理如果还在跑，用任务管理器结束 node.exe，或重开终端后 taskkill /F /IM node.exe');
    return;
  }

  // 1. DeepSeek key
  step(1, '查找 DeepSeek 官方 key');
  let dsKey;
  const found = findDeepSeekKey();
  if (found) {
    dsKey = found.key;
    ok(`从 ${found.from} 找到 ${mask(dsKey)}`);
  } else {
    warn('没找到，需要你手动输入一次');
    dsKey = await ask('    DeepSeek API key: ', { secret: true });
    if (!dsKey) throw new Error('没有 DeepSeek key，无法部署');
  }

  // 2. Ollama key
  step(2, 'Ollama Cloud key');
  let olKey = process.env.OLLAMA_API_KEY || readEnvFile(ENV_FILE).OLLAMA_API_KEY || '';
  if (olKey) {
    ok(`已存在 ${mask(olKey)}（直接沿用，想换就删掉 .env 里的 OLLAMA_API_KEY 再跑）`);
  } else {
    say('    在 https://ollama.com/settings/keys 创建，只填这一个。');
    olKey = await ask('    Ollama API key: ', { secret: true });
    if (!olKey) throw new Error('没有 Ollama key，无法部署');
  }

  // 3. 验证
  step(3, '验证两个 key（各发一次 max_tokens=1 的请求，花费可忽略）');
  const checks = [
    [DS, dsKey],
    [OL, olKey],
  ];
  let allOk = true;
  for (const [target, key] of checks) {
    process.stdout.write(`    ${target.label} … `);
    const r = await verifyChat(target, key);
    if (r.ok) {
      say(`✓ ${r.detail}`);
    } else {
      allOk = false;
      say(`✗ ${r.detail}`);
    }
  }
  if (!allOk && !FORCE) {
    const cont = await ask('    有 key 没通过验证。仍然继续部署吗？(y/N) ');
    if (!/^y(es)?$/i.test(cont)) {
      say('\n已取消，没有改动任何文件。');
      return;
    }
  }

  // 4. 写 .env
  step(4, '写入 .env');
  if (DRY) {
    ok(`将写入 ${ENV_FILE}`);
  } else {
    upsertEnv(ENV_FILE, { DEEPSEEK_API_KEY: dsKey, OLLAMA_API_KEY: olKey });
    ok(`已写入 ${ENV_FILE}`);
  }

  // 5. 自启
  step(5, '安装开机自启');
  if (DRY) {
    ok(`将在 ${STARTUP_FILE} 放置静默启动脚本（已有计划任务时跳过）`);
  } else {
    const how = installStartup();
    if (how === 'startup') ok(`已放入「启动」文件夹：${STARTUP_FILE}`);
    else ok(`已有计划任务 Ollama-DS-Router，跳过「启动」文件夹${how === 'task-cleaned' ? '（并删掉旧的 vbs）' : ''}`);
  }

  // 6. 立刻启动
  step(6, '启动路由');
  let status = await waitHealth(1500);
  if (status) {
    ok('已经有一个在运行，跳过启动（改了 key 的话请先结束它再重跑）');
  } else if (DRY) {
    ok('将用 run-hidden.vbs 静默启动');
  } else {
    launchRouter();
    process.stdout.write('    等待就绪 … ');
    status = await waitHealth(15000);
    say(status ? '✓' : '✗');
  }

  if (status) {
    say('');
    say('    ── 当前状态 ──────────────────────────────');
    say(`    北京时间  ${status.beijing}`);
    say(`    正在使用  ${status.provider}（${status.reason}）`);
    say(`    下次切换  ${status.nextSwitch ? `${status.nextSwitch.beijing} → ${status.nextSwitch.to}` : '48 小时内无'}`);
    for (const [id, u] of Object.entries(status.upstreams || {})) {
      say(`    ${u.label.padEnd(14)} key=${u.hasKey ? '已配置' : '缺失'}  model=${u.model}`);
    }
    say(`    状态页    http://127.0.0.1:8788/_router/status`);
    say(`    省钱统计  http://127.0.0.1:8788/_router/stats`);
  } else if (!DRY) {
    bad('路由没能在 15 秒内起来，看这里排查：');
    say(`    0) 静默启动的日志：${path.join(HERE, 'router.log')}`);
    say(`    1) 直接在目录里运行 node --env-file=.env router.mjs，看报错`);
    say(`    2) 端口被占：netstat -ano | findstr :8788`);
  }

  // 7. DSH 配置
  step(7, '检查 DSH 里的 time-router 路由');
  try {
    const patch = fs.readFileSync(DSH_PATCH, 'utf8');
    if (/^\s*time-router\s*:/m.test(patch)) {
      ok(`已配置：${DSH_PATCH}`);
      say('    重启 DSH 后，在模型列表里选「时间路由 / Auto」即可。');
    } else {
      warn('cordis.patch.yml 里没有 time-router，按 README「第三步」加上那一段');
    }
  } catch {
    warn(`读不到 ${DSH_PATCH}，跳过检查`);
  }

  say('');
  say('完成。');
}

main().catch((err) => {
  console.error(`\n部署失败：${err?.message || err}`);
  process.exitCode = 1;
});
