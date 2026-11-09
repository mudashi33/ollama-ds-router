#!/usr/bin/env node
/**
 * test-local.mjs —— 用两个本地假上游验证 router.mjs 的路由、模型名映射、失败回退、流式透传。
 * 不联网、不花钱。运行：node test-local.mjs
 */

import http from 'node:http';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

function makeMock(name, port) {
  let calls = 0;
  let failsLeft = 0;
  let failStatus = 503;
  let gzipNext = false;
  let abortNext = false;
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
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ds = makeMock('ds', 9101);
const ol = makeMock('ol', 9102);

await new Promise((r) => ds.server.listen(9101, '127.0.0.1', r));
await new Promise((r) => ol.server.listen(9102, '127.0.0.1', r));

const router = spawn(process.execPath, ['router.mjs'], {
  cwd: here,
  env: {
    ...process.env,
    ROUTER_PORT: '8799',
    DEEPSEEK_BASE: 'http://127.0.0.1:9101',
    DEEPSEEK_API_KEY: 'test-ds',
    DEEPSEEK_MODEL: 'deepseek-flash',
    OLLAMA_BASE: 'http://127.0.0.1:9102/v1',
    OLLAMA_API_KEY: 'test-ol',
    OLLAMA_MODEL: 'deepseek-v4.1-flash',
  },
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
  const ok =
    j.requests >= 1 &&
    j.byProvider.deepseek.prompt >= 5 &&
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
    env: {
      ...process.env,
      ROUTER_PORT: '8800',
      ROUTER_CLOCK_OFFSET_MS: String(offset),
      DEEPSEEK_BASE: 'http://127.0.0.1:9101',
      DEEPSEEK_API_KEY: 'test-ds',
      DEEPSEEK_MODEL: 'deepseek-flash',
      OLLAMA_BASE: 'http://127.0.0.1:9102/v1',
      OLLAMA_API_KEY: 'test-ol',
      OLLAMA_MODEL: 'deepseek-v4.1-flash',
    },
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

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('\n--- router 日志 ---\n' + routerLog);
  process.exit(1);
}
process.exit(0);
