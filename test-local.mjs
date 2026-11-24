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
  // 上游回了 4xx 头 + 半截正文就再也不结束：验证路由器读错误正文也有超时（以前会一直挂着）
  let hangBodyNext = null;
  // 余额接口挂死：验证看板两家并行拉而不是串行
  let hangBalance = false;
  // 自定义错误正文：验看板把上游正文拼进 HTML 时有没有转义
  let failMsgNext = null;
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

    // 控制端点：/_failmsg?msg=... —— 下一次请求回 400，正文里带自定义 message
    if (url.pathname === '/_failmsg') {
      failMsgNext = url.searchParams.get('msg') || 'boom';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"failMsgNext":true}');
      return;
    }

    // 控制端点：/_hangbody?status=400&partial=abc —— 下一次请求回 4xx 头 + 半截正文，永不结束
    if (url.pathname === '/_hangbody') {
      hangBodyNext = {
        status: Number(url.searchParams.get('status') || 400),
        partial: url.searchParams.get('partial') || '{"error":{"message":"trunc',
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ hangBodyNext }));
      return;
    }

    // 控制端点：/_hangbalance —— 余额接口挂死不回（看板并行拉才不会被串行放大）
    if (url.pathname === '/_hangbalance') {
      hangBalance = url.searchParams.get('on') !== '0';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ hangBalance }));
      return;
    }

    // 余额接口：挂死模式下永不响应，用来量看板渲染耗时
    if (url.pathname === '/user/balance' || url.pathname === '/api/balance' || url.pathname === '/v1/api/balance') {
      if (hangBalance) return; // 故意不回，也不 end
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"no balance endpoint"}');
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
    // 看板渲染时会去拉两家余额（GET，没有 body），假上游不认这些路径就直接回 404，
    // 别让 JSON.parse('') 把整个测试进程炸掉。
    // 两家 base 不同（deepseek 是 http://127.0.0.1:9101，ollama 带 /v1），所以按后缀认
    if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `${name} 假上游没有 ${url.pathname}` } }));
      return;
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"假上游收到空 body"}}');
      return;
    }
    calls += 1;

    if (failMsgNext !== null) {
      const msg = failMsgNext;
      failMsgNext = null;
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: msg } }));
      return;
    }

    if (failsLeft > 0) {
      failsLeft -= 1;
      res.writeHead(failStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `${name} 故意返回 ${failStatus}` } }));
      return;
    }

    if (hangBodyNext) {
      const { status, partial } = hangBodyNext;
      hangBodyNext = null;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.flushHeaders();
      res.write(partial); // 写半截就撒手，永不 end
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
        served_max_tokens_field: body.max_tokens ?? null,
        served_max_completion_tokens: body.max_completion_tokens ?? null,
        // 老版 /v1/completions 的 prompt 要在这里变成 messages 才说明转换真的成功了
        served_has_messages: Array.isArray(body.messages),
        served_first_message: body.messages?.[0]?.content ?? null,
        served_prompt: body.prompt ?? null,
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
    hangBody(status = 400, partial = undefined) {
      const q = new URLSearchParams({ status: String(status) });
      if (partial !== undefined) q.set('partial', partial);
      return fetch(`http://127.0.0.1:${port}/_hangbody?${q}`);
    },
    failMsg(msg) {
      return fetch(`http://127.0.0.1:${port}/_failmsg?msg=${encodeURIComponent(msg)}`);
    },
    hangBalance(on = true) {
      return fetch(`http://127.0.0.1:${port}/_hangbalance?on=${on ? 1 : 0}`);
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
    // 读上游错误正文的超时（默认 15 秒）。压到 2 秒，「错误正文不结束」那条用例才跑得快。
    ROUTER_ERROR_BODY_TIMEOUT_MS: '2000',
    // 余额缓存归零 + 单家超时 2 秒：「并行拉」那条用例才分得出来（并行约 2s，串行约 4s）
    ROUTER_BALANCE_TTL_MS: '0',
    ROUTER_BALANCE_TIMEOUT_MS: '2000',
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
//     token 上限」。护栏要把「长对话 + 小得不合理」的预算抬回 128000（128k），同时不碰探活/短对话。
{
  const long = Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: `m${i}` }));
  const r1 = await chat('deepseek', { max_tokens: 1, messages: long });
  const j1 = await r1.json();
  check('长对话 max_tokens=1 被抬到 128000', j1.served_max_tokens === 128000, `上游收到 ${j1.served_max_tokens}`);

  const r2 = await chat('deepseek', { max_tokens: 32 });
  const j2 = await r2.json();
  check('短对话 max_tokens=32 保持原样', j2.served_max_tokens === 32, `上游收到 ${j2.served_max_tokens}`);

  const r3 = await chat('deepseek', { max_tokens: 256000, messages: long });
  const j3 = await r3.json();
  check('长对话正常预算不被改动', j3.served_max_tokens === 256000, `上游收到 ${j3.served_max_tokens}`);

  const r4 = await chat('deepseek', { max_tokens: 128000, messages: long });
  const j4 = await r4.json();
  check('刚好等于护栏值时不再抬（128000 原样）', j4.served_max_tokens === 128000, `上游收到 ${j4.served_max_tokens}`);

  const s = await (await fetch('http://127.0.0.1:8799/_router/stats')).json();
  const g = s.maxTokensGuard || {};
  check(
    '护栏计数可观测',
    g.hits >= 1 && g.last?.from === 1 && g.last?.to === 128000,
    `hits=${g.hits} last=${JSON.stringify(g.last)}`,
  );
}

// 6.75 护栏要同时改两个字段，还要认字符串 max_tokens=1 + max_completion_tokens=1
//      以前命中第一个就 return，上游照旧按 max_completion_tokens=1 只吐 1 个 token。
{
  const long = Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: 'm' + i }));
  const r = await chat('deepseek', { max_tokens: 1, max_completion_tokens: 1, messages: long });
  const j = await r.json();
  check(
    '两个预算字段同时为 1 时都抬到 128000',
    j.served_max_tokens_field === 128000 && j.served_max_completion_tokens === 128000,
    'max_tokens=' + j.served_max_tokens_field + ' max_completion_tokens=' + j.served_max_completion_tokens,
  );

  const r2 = await chat('deepseek', { max_tokens: '1', messages: long });
  const j2 = await r2.json();
  check('字符串 "1" 也认', j2.served_max_tokens_field === 128000, '上游收到 ' + j2.served_max_tokens_field);

  const r3 = await chat('deepseek', { max_tokens: '256000', messages: long });
  const j3 = await r3.json();
  check('字符串 "256000" 不误抬', j3.served_max_tokens_field === '256000', '上游收到 ' + j3.served_max_tokens_field + '（原样）');

  const s = await (await fetch('http://127.0.0.1:8799/_router/stats')).json();
  const g = s.maxTokensGuard || {};
  check(
    '双字段抬升有记录（fields 逐个列出来）',
    Array.isArray(g.last?.fields) && g.last.fields.length >= 1,
    'field=' + g.last?.field + ' fields=' + JSON.stringify(g.last?.fields),
  );
}

// 6.76 上游回 4xx 头 + 半截正文后不结束：读错误正文必须有超时，不能把请求挂死
{
  await setMode('deepseek');
  await ds.hangBody(400, '{"error":{"message":"trunc');
  await ol.hangBody(400, '{"error":{"message":"trunc');
  const t0 = Date.now();
  const r = await chat(null);
  const ms = Date.now() - t0;
  await r.text().catch(() => '');
  // 两家各 2 秒超时，串行最多约 4 秒；阈值 8 秒既能抓住「完全没超时」，也不容易误红
  check('上游错误正文不结束时不再挂死', r.status >= 400 && ms < 8000, 'status=' + r.status + ' 用时 ' + ms + 'ms');
}

// 6.77 看板转义：上游错误正文里的 HTML 不能原样活着进页面
{
  await setMode('deepseek');
  const payload = '<img src=x onerror="document.title=1">';
  await ds.failMsg(payload);
  await ol.failMsg(payload);
  await chat(null).then((r) => r.text()).catch(() => '');
  const html = await (await fetch('http://127.0.0.1:8799/_router')).text();
  check(
    '看板把上游错误正文转义了',
    !html.includes('onerror="document.title=1"') && html.includes('&lt;img'),
    '含未转义 onerror=' + html.includes('onerror="document.title=1"') + ' 含 &lt;img=' + html.includes('&lt;img'),
  );
}

// 6.78 余额接口挂死时看板要并行拉（以前串行 8+8=16 秒，而页面每 5 秒自动刷新）
{
  await ds.hangBalance(true);
  await ol.hangBalance(true);
  const t0 = Date.now();
  const r = await fetch('http://127.0.0.1:8799/_router');
  await r.text();
  const ms = Date.now() - t0;
  await ds.hangBalance(false);
  await ol.hangBalance(false);
  // 单家 2 秒超时：并行 ≈ 2s，串行 ≈ 4s，阈值取 3.5s 才分得出来
  check('余额挂死时看板并行拉（< 3.5s，串行会是 4s）', r.ok && ms < 3500, '用时 ' + ms + 'ms');
}

// 6.79 老版 /v1/completions（body 是 prompt）要转成 messages 再转发
{
  const r = await fetch('http://127.0.0.1:8799/v1/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-router-force': 'deepseek' },
    body: JSON.stringify({ model: 'auto', prompt: 'hello from prompt' }),
  });
  const j = await r.json();
  check(
    '老版 completions 的 prompt 被转成 messages',
    r.ok && j.served_has_messages === true && j.served_first_message === 'hello from prompt' && j.served_prompt === null,
    'has_messages=' + j.served_has_messages + ' first=' + JSON.stringify(j.served_first_message) + ' prompt=' + JSON.stringify(j.served_prompt),
  );
}

// 6.85 userRequests 记「用户问了几次」，requests 记「打了几家上游」
{
  await setMode('deepseek');
  const before = await (await fetch('http://127.0.0.1:8799/_router/stats')).json();
  await ds.fail(429, 1);
  const r = await chat(null);
  await r.text().catch(() => '');
  const after = await (await fetch('http://127.0.0.1:8799/_router/stats')).json();
  const dReq = after.requests - before.requests;
  const dUser = after.userRequests - before.userRequests;
  check('一次提问兜底成功：requests +2，userRequests +1', r.ok && dReq === 2 && dUser === 1, 'requests +' + dReq + ' userRequests +' + dUser);
  await sleep(1800);
  const raw = JSON.parse(fs.readFileSync(path.join(TMP, 'stats.json'), 'utf8'));
  const day = Object.values(raw.days || {}).pop() || {};
  check('userRequests 落盘', (day.userRequests || 0) >= 1 && (day.userRequests || 0) <= (day.requests || 0), 'stats.json 今日 userRequests=' + day.userRequests + ' requests=' + day.requests);
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

// 6.95 看板合计行：客户端断开不能顶红字（累计上千条，挂红字太扎眼），真失败才红
{
  const html = await (await fetch('http://127.0.0.1:8799/_router')).text();
  const totalRow = (html.match(/<tr><td>合计<\/td>[\s\S]*?<\/tr>/) || [''])[0];
  const ok =
    totalRow.includes('断开 ') &&
    !/客户端断开 \d/.test(totalRow) &&
    !/<span class="warn">[^<]*断开/.test(totalRow);
  check('看板合计行把客户端断开降成灰字', ok, totalRow.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120));
}


// 6.96 落盘是 1.5 秒去抖的：进程被 SIGTERM 时必须先把脏数据刷下去，否则这一笔就丢了
{
  const stats3 = path.join(TMP, 'stats3.json');
  // Windows 没有真信号：child.kill('SIGTERM') 是 TerminateProcess，router 的 SIGTERM
  // handler 根本不会执行。所以这里用 tools/test-sigterm-wrapper.mjs 起 router，
  // 由它在本进程内 process.emit('SIGTERM') 走同一条 handler 分支。
  const r3 = spawn(process.execPath, [path.join('tools', 'test-sigterm-wrapper.mjs')], {
    cwd: here,
    env: sandboxEnv({
      ROUTER_PORT: '8801',
      ROUTER_STATS_FILE: stats3,
      ROUTER_MODE_FILE: path.join(TMP, 'mode3.json'),
      ROUTER_LOG_FILE: path.join(TMP, 'router3.log'),
      DEEPSEEK_BASE: 'http://127.0.0.1:9101',
      DEEPSEEK_API_KEY: 'test-ds',
      DEEPSEEK_MODEL: 'deepseek-flash',
      OLLAMA_BASE: 'http://127.0.0.1:9102/v1',
      OLLAMA_API_KEY: 'test-ol',
      OLLAMA_MODEL: 'deepseek-v4.1-flash',
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  r3.stdout.on('data', () => {});
  r3.stderr.on('data', () => {});
  let up3 = false;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch('http://127.0.0.1:8801/_router/status')).ok) { up3 = true; break; }
    } catch {
      /* 还没起来 */
    }
    await sleep(100);
  }
  let ok3 = false;
  if (up3) {
    const c = await fetch('http://127.0.0.1:8801/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    await c.text().catch(() => '');
    // 请求一结束就触发 SIGTERM：离 1.5 秒去抖落盘还差得远。
    // Windows 上 kill('SIGTERM') 是硬杀，handler 跑不到，所以往 wrapper 的 stdin 写一字节，
    // 由它 process.emit('SIGTERM')，走的是 router.mjs 里同一个 handler。
    const exited = new Promise((r) => r3.once('exit', r));
    r3.stdin.end('go\n');
    await exited;
    try {
      const saved = JSON.parse(fs.readFileSync(stats3, 'utf8'));
      // 账本是按天的：顶层只有 {version, days}，请求计数在 days 的每个桶里
      ok3 = Object.values(saved.days || {}).some((d) => (d?.requests || 0) >= 1);
    } catch {
      ok3 = false;
    }
  } else {
    r3.kill();
  }
  check('SIGTERM 时把未落盘的账先刷下去（不再丢最后一笔）', ok3, up3 ? 'SIGTERM 后 stats3.json 里能看到这一笔' : '第三个实例没起来');
}

// 6.97 背压等待不能每来一块就挂一对新监听器（会冒出 MaxListenersExceededWarning）
{
  check('没有 MaxListenersExceededWarning（drain 监听器不泄漏）', !routerLog.includes('MaxListenersExceededWarning'), 'routerLog 长度 ' + routerLog.length);
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
