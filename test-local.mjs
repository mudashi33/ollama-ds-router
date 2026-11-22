#!/usr/bin/env node
/**
 * test-local.mjs —— 用两个本地假上游验证 router.mjs 的路由、模型名映射、失败回退、流式透传。
 * 不联网、不花钱。运行：node test-local.mjs
 */

import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

// 测试用的账本/模式/日志一律写到临时目录：以前直接跑在仓库里，会把测试流量混进
// 真实的 stats.json 和 mode.json（线上账本里那些「测试 2 次」就是这么来的）。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'router-test-'));
const sandboxEnv = (extra) => ({
  ...process.env,
  ROUTER_STATS_FILE: path.join(TMP, 'stats.json'),
  ROUTER_MODE_FILE: path.join(TMP, 'mode.json'),
  ROUTER_LOG_FILE: path.join(TMP, 'router.log'),
  ...extra,
});

function makeMock(name, port) {
  let calls = 0;
  let failsLeft = 0;
  let failStatus = 503;
  let gzipNext = false;
  let abortNext = false;
  // 慢流：每 pieceMs 吐一块，共 pieces 块。用来验证「客户端断开要传播到上游」——
  // 快流会瞬间写完，路由器还没来得及发现客户端跑了就结束了，测不出来。
  let slowNext = null;
  let slowPrematureClose = 0; // 上游视角：自己还没写完就被掐断的次数
  let slowFinished = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');

    // 控制端点：/_fail?status=429&count=1
    if (url.pathname === '/_fail') {
      failStatus = Number(url.searchParams.get('status') || 503);
      failsLeft = Number(url.searchParams.get('count') || 1);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ failStatus, failsLeft }));
      return;
    }

    // 控制端点：/_abort —— 下一次请求回 200 头、但在吐任何数据之前就掐断连接
    // （真实上游对不认识的参数/图片可能会这样，而不是回 400）
    if (url.pathname === '/_abort') {
      abortNext = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"abortNext":true}');
      return;
    }

    // 控制端点：/_slow?pieces=40&ms=100 —— 下一次流式响应慢慢吐，给客户端留出「中途跑掉」的窗口
    if (url.pathname === '/_slow') {
      slowNext = {
        pieces: Number(url.searchParams.get('pieces') || 40),
        ms: Number(url.searchParams.get('ms') || 100),
      };
      slowPrematureClose = 0;
      slowFinished = 0;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(slowNext));
      return;
    }

    // 控制端点：/_slowstate —— 慢流有没有被上游/客户端掐断
    if (url.pathname === '/_slowstate') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ prematureClose: slowPrematureClose, finished: slowFinished, pending: slowNext }));
      return;
    }

    // 控制端点：/_gzip —— 下一次流式响应用 gzip 发（模拟真实上游）
    if (url.pathname === '/_gzip') {
      gzipNext = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"gzipNext":true}');
      return;
    }

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    calls += 1;

    if (failsLeft > 0) {
      failsLeft -= 1;
      res.writeHead(failStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `${name} 故意返回 ${failStatus}` } }));
      return;
    }

    if (abortNext) {
      abortNext = false;
      // 先把响应头发出去，再在写任何 body 之前强行断开：模拟「上游在首字节前断流」
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      setTimeout(() => res.destroy(), 20);
      return;
    }

    const id = `chatcmpl-${name}-${calls}`;
    if (body.stream && slowNext) {
      const { pieces, ms } = slowNext;
      slowNext = null;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.flushHeaders();
      let closed = false;
      res.on('close', () => {
        closed = true;
        if (!res.writableFinished) slowPrematureClose++;
      });
      for (let i = 0; i < pieces && !closed; i++) {
        const piece = `data: ${JSON.stringify({ id, choices: [{ index: 0, delta: { content: `p${i}` } }] })}\n\n`;
        if (!res.write(piece)) await new Promise((r) => res.once('drain', r));
        await sleep(ms);
      }
      if (!closed) {
        slowFinished++;
        res.write(`data: ${JSON.stringify({ id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 40 } })}\n\n`);
        res.end('data: [DONE]\n\n');
      }
      return;
    }
    if (body.stream) {
      let sse = '';
      for (const piece of ['he', 'llo']) {
        sse += `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: piece } }] })}\n\n`;
      }
      sse += `data: ${JSON.stringify({ id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n`;
      sse += 'data: [DONE]\n\n';
      if (gzipNext) {
        gzipNext = false;
        const buf = zlib.gzipSync(Buffer.from(sse));
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'content-encoding': 'gzip',
          'content-length': String(buf.length),
        });
        res.end(buf);
      } else {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sse);
      }
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id,
        object: 'chat.completion',
        model: body.model,
        server: name,
        // 回显上游实际收到的输出预算：max_tokens 护栏的断言要靠它
        served_max_tokens: body.max_tokens ?? body.max_completion_tokens ?? null,
        choices: [{ index: 0, message: { role: 'assistant', content: `reply from ${name}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }),
    );
  });
  return {
    server,
    name,
    get calls() {
      return calls;
    },
    fail(status, count = 1) {
      return fetch(`http://127.0.0.1:${port}/_fail?status=${status}&count=${count}`);
    },
    gzip() {
      return fetch(`http://127.0.0.1:${port}/_gzip`);
    },
    abort() {
      return fetch(`http://127.0.0.1:${port}/_abort`);
    },
    slow(pieces = 40, ms = 100) {
      return fetch(`http://127.0.0.1:${port}/_slow?pieces=${pieces}&ms=${ms}`);
    },
    slowState() {
      return fetch(`http://127.0.0.1:${port}/_slowstate`).then((r) => r.json());
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ds = makeMock('ds', 9101);
const ol = makeMock('ol', 9102);

await new Promise((r) => ds.server.listen(9101, '127.0.0.1', r));
await new Promise((r) => ol.server.listen(9102, '127.0.0.1', r));

// 测试固定用 auto-ds（否则线上切到 auto-ollama 后「强制 deepseek」这类断言的含义会变）
const FIXED_MODE = JSON.stringify({ mode: 'auto-ds', at: new Date().toISOString() });
fs.writeFileSync(path.join(TMP, 'mode.json'), FIXED_MODE);
fs.writeFileSync(path.join(TMP, 'mode2.json'), FIXED_MODE);

const router = spawn(process.execPath, ['router.mjs'], {
  cwd: here,
  env: sandboxEnv({
    ROUTER_PORT: '8799',
    DEEPSEEK_BASE: 'http://127.0.0.1:9101',
    DEEPSEEK_API_KEY: 'test-ds',
    DEEPSEEK_MODEL: 'deepseek-flash',
    OLLAMA_BASE: 'http://127.0.0.1:9102/v1',
    OLLAMA_API_KEY: 'test-ol',
    OLLAMA_MODEL: 'deepseek-v4.1-flash',
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
});

let routerLog = '';
router.stdout.on('data', (d) => (routerLog += d.toString()));
router.stderr.on('data', (d) => (routerLog += d.toString()));

// 等端口就绪
let ready = false;
for (let i = 0; i < 50; i++) {
  try {
    const r = await fetch('http://127.0.0.1:8799/_router/status');
    if (r.ok) {
      ready = true;
      break;
    }
  } catch {
    /* 还没起来 */
  }
  await sleep(100);
}
if (!ready) {
  console.error('router 没启动起来：\n' + routerLog);
  process.exit(1);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`);
}

// 切运行模式：带 x-router-force 的请求会被当成「探针」不计入账本，
// 所以「要进账本」的断言必须靠切模式来定向，而不是靠 force 头。
async function setMode(m) {
  const r = await fetch(`http://127.0.0.1:8799/_router/prefer?prefer=${m}`);
  return r.json();
}

async function chat(force, body = {}) {
  const r = await fetch('http://127.0.0.1:8799/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(force ? { 'x-router-force': force } : {}) },
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], ...body }),
  });
  return r;
}

// 1. 强制官方
{
  const r = await chat('deepseek');
  const j = await r.json();
  check('强制 deepseek', j.server === 'ds' && j.model === 'deepseek-flash', `server=${j.server} model=${j.model}`);
}

// 2. 强制 ollama，其首次 429 → 应回退到 deepseek
{
  await ol.fail(429, 1);
  const r = await chat('ollama');
  const j = await r.json();
  check('429 限流时回退', r.ok && j.server === 'ds', `status=${r.status} server=${j.server}`);
}

// 3. 强制 ollama，返回 400（参数方言不被接受）→ 也应回退
{
  await ol.fail(400, 1);
  const r = await chat('ollama');
  const j = await r.json();
  check('400 参数不兼容时回退', r.ok && j.server === 'ds', `status=${r.status} server=${j.server}`);
}

// 4. 再请求 ollama，这次成功，且模型名已映射
{
  const r = await chat('ollama');
  const j = await r.json();
  check('模型名映射', j.server === 'ol' && j.model === 'deepseek-v4.1-flash', `server=${j.server} model=${j.model}`);
}

// 4.5 上游先回 200 头、但在首字节前断流 → 客户端什么都还没收到，应换另一家重试
{
  await ol.abort();
  try {
    const r = await chat('ollama');
    const j = await r.json();
    check('首字节前断流时回退', r.ok && j.server === 'ds', `status=${r.status} server=${j.server}`);
  } catch (err) {
    check('首字节前断流时回退', false, `客户端报错：${err.message}`);
  }
}

// 5. 流式透传
{
  const r = await chat('deepseek', { stream: true });
  const text = await r.text();
  const chunks = text.split('\n\n').filter((s) => s.startsWith('data:'));
  const hasDone = text.includes('[DONE]');
  let content = '';
  for (const c of chunks) {
    const data = c.slice(5).trim();
    if (data === '[DONE]') continue;
    try {
      content += JSON.parse(data).choices?.[0]?.delta?.content ?? '';
    } catch {
      /* ignore */
    }
  }
  check('流式 SSE 透传', r.ok && content === 'hello' && hasDone, `content="${content}" done=${hasDone}`);
}

// 5.5 上游用 gzip 编码时，不能把 content-encoding 透传出去（否则客户端解压明文失败，
//     表现就是「流在完成事件之前就结束了」）
{
  await ds.gzip();
  try {
    const r = await chat('deepseek', { stream: true });
    const enc = r.headers.get('content-encoding');
    const text = await r.text();
    let content = '';
    for (const c of text.split('\n\n').filter((s) => s.startsWith('data:'))) {
      const data = c.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        content += JSON.parse(data).choices?.[0]?.delta?.content ?? '';
      } catch {
        /* 半截 chunk，忽略 */
      }
    }
    const ok = enc === null && content === 'hello' && text.includes('[DONE]');
    check('上游 gzip 时不透传 content-encoding', ok, `enc=${enc} content="${content}" done=${text.includes('[DONE]')}`);
  } catch (err) {
    check('上游 gzip 时不透传 content-encoding', false, `客户端解码失败：${err.message}`);
  }
}

// 5.6 用量统计（含流式 usage 解析；测试请求与真实请求分开记账）
{
  // 一次不带 x-router-force 的"真实"请求：它才进 requests / byProvider / 省钱统计
  await chat(null, { messages: [{ role: 'user', content: '真实请求' }] });
  const r = await fetch('http://127.0.0.1:8799/_router/stats');
  const j = await r.json();
  // 这次请求走哪一家取决于运行时的模式（auto-ollama 会走 ollama），所以按两家合计断言，
  // 不然这条断言会随"今天几点跑测试"红绿跳变——它要验的是记账，不是路由。
  const accounted = j.byProvider.deepseek.prompt + j.byProvider.ollama.prompt;
  const ok =
    j.requests >= 1 &&
    accounted >= 5 &&
    j.probeRequests >= 5 &&
    j.probeCny > 0 &&
    typeof j.actualCny === 'number' &&
    j.tokens.input >= 5;
  check(
    '用量与成本统计',
    ok,
    `真实 ${j.requests} 次（${j.tokens.input} tok，¥${j.actualCny}）/ 测试 ${j.probeRequests} 次 ¥${j.probeCny.toFixed(6)}`,
  );
}

// 6. 状态页
{
  const r = await fetch('http://127.0.0.1:8799/_router/status');
  const j = await r.json();
  check('状态页', r.ok && !!j.provider && !!j.beijing, `provider=${j.provider} bj=${j.beijing} next=${j.nextSwitch?.beijing}`);
}

// 6.5 不带 force 时，按"北京时间"自动选 Ollama（把时钟拨到周五 10:00）
{
  const target = new Date('2026-11-06T10:00:00+08:00').getTime();
  const offset = target - Date.now();
  const router2 = spawn(process.execPath, ['router.mjs'], {
    cwd: here,
    env: sandboxEnv({
      ROUTER_PORT: '8800',
      ROUTER_STATS_FILE: path.join(TMP, 'stats2.json'),
      ROUTER_MODE_FILE: path.join(TMP, 'mode2.json'),
      ROUTER_LOG_FILE: path.join(TMP, 'router2.log'),
      ROUTER_CLOCK_OFFSET_MS: String(offset),
      DEEPSEEK_BASE: 'http://127.0.0.1:9101',
      DEEPSEEK_API_KEY: 'test-ds',
      DEEPSEEK_MODEL: 'deepseek-flash',
      OLLAMA_BASE: 'http://127.0.0.1:9102/v1',
      OLLAMA_API_KEY: 'test-ol',
      OLLAMA_MODEL: 'deepseek-v4.1-flash',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log2 = '';
  router2.stdout.on('data', (d) => (log2 += d.toString()));
  router2.stderr.on('data', (d) => (log2 += d.toString()));

  let up = false;
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch('http://127.0.0.1:8800/_router/status')).ok) {
        up = true;
        break;
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(100);
  }

  let provider = '';
  let server = '';
  let bj = '';
  if (up) {
    const s = await (await fetch('http://127.0.0.1:8800/_router/status')).json();
    provider = s.provider;
    bj = s.beijing;
    const r = await fetch('http://127.0.0.1:8800/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    server = (await r.json()).server;
  }
  router2.kill();
  check(
    '按时间自动切到 Ollama（拨钟到周五 10:00）',
    up && provider === 'ollama' && server === 'ol',
    `bj=${bj} provider=${provider} server=${server}${up ? '' : ' 未启动:' + log2}`,
  );
}

// 6.7 max_tokens 护栏：DSH 长会话里 pi-ai 会把 max_tokens 钳成 1（估算退化 → available 为负 →
//     Math.max(1, …)），上游只吐 1 个 token 回 finish_reason=length，客户端就显示「已达到输出
//     token 上限」。护栏要把「长对话 + 小得不合理」的预算抬回 8192，同时不碰探活/短对话。
{
  const long = Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: `m${i}` }));
  const r1 = await chat('deepseek', { max_tokens: 1, messages: long });
  const j1 = await r1.json();
  check('长对话 max_tokens=1 被抬到 8192', j1.served_max_tokens === 8192, `上游收到 ${j1.served_max_tokens}`);

  const r2 = await chat('deepseek', { max_tokens: 32 });
  const j2 = await r2.json();
  check('短对话 max_tokens=32 保持原样', j2.served_max_tokens === 32, `上游收到 ${j2.served_max_tokens}`);

  const r3 = await chat('deepseek', { max_tokens: 256000, messages: long });
  const j3 = await r3.json();
  check('长对话正常预算不被改动', j3.served_max_tokens === 256000, `上游收到 ${j3.served_max_tokens}`);

  const s = await (await fetch('http://127.0.0.1:8799/_router/stats')).json();
  const g = s.maxTokensGuard || {};
  check(
    '护栏计数可观测',
    g.hits >= 1 && g.last?.from === 1 && g.last?.to === 8192,
    `hits=${g.hits} last=${JSON.stringify(g.last)}`,
  );
}
// 6.8 客户端中途断开 → 上游请求必须被中止（否则 DSH 按 Esc 之后还在计费）
{
  await setMode('ollama'); // 走模式而不是 x-router-force：force 会被当探针、不进账本
  await ol.slow(60, 100); // 6 秒的慢流，留出足够窗口
  const before = await (await fetch('http://127.0.0.1:8799/_router/stats')).json();
  const ac = new AbortController();
  const p = fetch('http://127.0.0.1:8799/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    signal: ac.signal,
  });
  p.catch(() => {});
  // 等第一块数据真的到了，再「按 Esc」，模拟真实使用
  const resp = await p;
  const reader = resp.body.getReader();
  await reader.read();
  const abortedAt = Date.now();
  ac.abort();
  // 上游应该很快发现自己被掐（不是等 60 块吐完）
  let st = { prematureClose: 0, finished: 0 };
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    st = await ol.slowState();
    if (st.prematureClose > 0) break;
  }
  const ms = Date.now() - abortedAt;
  check('客户端断开后上游被中止', st.prematureClose >= 1 && st.finished === 0, `prematureClose=${st.prematureClose} finished=${st.finished} 用时 ${ms}ms`);

  await sleep(300);
  const after = await (await fetch('http://127.0.0.1:8799/_router/stats')).json();
  check(
    '客户端断开计数可观测',
    after.clientAborted > before.clientAborted,
    `clientAborted ${before.clientAborted} → ${after.clientAborted}`,
  );
  // scheduleSave 有 1.5s 防抖，等它落盘再验账本里也记了
  await sleep(1800);
  const raw = JSON.parse(fs.readFileSync(path.join(TMP, 'stats.json'), 'utf8'));
  const days = Object.values(raw.days || {});
  const day = days[days.length - 1] || {};
  check(
    '客户端断开写进账本',
    (day.clientAborted || 0) >= 1,
    `stats.json 今日 clientAborted=${day.clientAborted} requests=${day.requests}`,
  );
}

// 6.9 失败要进账本（以前 failed 只在内存里，stats.json 里永远是 0）
{
  await setMode('deepseek');
  const before = await (await fetch('http://127.0.0.1:8799/_router/stats')).json();
  // 两家都回 400：400 是可重试的，于是会依次试过两家、最后 503 —— 正好产生 2 条失败记录
  await ds.fail(400, 2);
  await ol.fail(400, 2);
  const r = await chat(null);
  const after = await (await fetch('http://127.0.0.1:8799/_router/stats')).json();
  const dayKeys = Object.keys(after.history?.days || {});
  const day = after.history.days[dayKeys[dayKeys.length - 1]] || {};
  check(
    '失败写进账本（不再恒 0）',
    r.status >= 400 && after.failed > before.failed && (day.failed || 0) > 0,
    `status=${r.status} stats.failed ${before.failed}→${after.failed} 今日 failed=${day.failed}`,
  );
  await sleep(1800);
  const raw = JSON.parse(fs.readFileSync(path.join(TMP, 'stats.json'), 'utf8'));
  const persisted = Object.values(raw.days || {}).reduce((n, d) => n + (d.failed || 0), 0);
  check('失败计数已落盘', persisted >= 1, `stats.json 累计 failed=${persisted}`);
  // 口径自洽：总次数必须等于三种结局之和，否则看板上的「今日 N 次」会互相打架
  check(
    'requests = ok + failed + clientAborted',
    after.requests === after.ok + after.failed + after.clientAborted,
    `requests=${after.requests} ok=${after.ok} failed=${after.failed} clientAborted=${after.clientAborted}`,
  );
}

// 7. 两家都挂时返回 503
{
  await ol.fail(503, 5);
  await ds.fail(503, 5);
  const r = await chat('deepseek');
  check('两家都失败时 503', r.status === 503, `status=${r.status}`);
}

router.kill();
ds.server.close();
ol.server.close();

// 临时目录用完就删（失败时留着，方便看 stats.json 里到底记了什么）
if (!results.some((r) => !r.ok)) fs.rmSync(TMP, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('\n--- router 日志 ---\n' + routerLog);
  process.exit(1);
}
process.exit(0);
