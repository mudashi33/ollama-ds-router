#!/usr/bin/env node
/**
 * probe.mjs —— 冒烟测试：DeepSeek 官方 API vs Ollama Cloud（OpenAI 兼容端点）
 *
 * 目的：在写路由代理之前，先确认两家对 DSH 真正会用到的能力是否兼容：
 *   1. 普通非流式补全
 *   2. 声明 function tools 后能否正确返回 tool_calls
 *   3. 把 tool 结果回填后能否给出最终回答（agent 的多轮工具往返）
 *   4. SSE 流式 + stream_options.include_usage
 *   5. 相同长前缀第二次请求是否能命中上游缓存（决定切 provider 的代价）
 *
 * 用法（PowerShell）：
 *   $env:DEEPSEEK_API_KEY="sk-..."
 *   $env:OLLAMA_API_KEY="..."
 *   node probe.mjs
 *
 * 可选环境变量：
 *   DEEPSEEK_BASE   默认 https://api.deepseek.com
 *   DEEPSEEK_MODEL  默认 deepseek-flash
 *   OLLAMA_BASE     默认 https://ollama.com/v1
 *   OLLAMA_MODEL    默认 deepseek-v4.1-flash
 */

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.split('=')[1] : null;

const providers = [
  {
    id: 'deepseek',
    label: 'DeepSeek 官方',
    base: (process.env.DEEPSEEK_BASE || 'https://api.deepseek.com').replace(/\/+$/, ''),
    key: process.env.DEEPSEEK_API_KEY || '',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
  },
  {
    id: 'ollama',
    label: 'Ollama Cloud',
    base: (process.env.OLLAMA_BASE || 'https://ollama.com/v1').replace(/\/+$/, ''),
    key: process.env.OLLAMA_API_KEY || '',
    model: process.env.OLLAMA_MODEL || 'deepseek-v4.1-flash',
  },
].filter((p) => !only || p.id === only);

const results = [];
function record(provider, test, ok, detail = '', ms = null) {
  results.push({ provider: provider.label, id: provider.id, test, ok, detail, ms });
}

function endpoint(p) {
  return `${p.base}/chat/completions`;
}

function headers(p) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${p.key}`,
  };
}

async function postJson(p, body, timeoutMs = 120000) {
  const t0 = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint(p), {
      method: 'POST',
      headers: headers(p),
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    const ms = Math.round(performance.now() - t0);
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON 错误体，保留 text */
    }
    return { ok: res.ok, status: res.status, ms, json, text };
  } finally {
    clearTimeout(timer);
  }
}

async function postStream(p, body, timeoutMs = 180000) {
  const t0 = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint(p), {
      method: 'POST',
      headers: headers(p),
      body: JSON.stringify({ ...body, stream: true }),
      signal: ac.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      return { ok: res.ok, status: res.status, ms: Math.round(performance.now() - t0), text, chunks: 0, usage: null, content: '' };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let chunks = 0;
    let usage = null;
    let content = '';
    let sawDone = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of raw.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            sawDone = true;
            continue;
          }
          if (!data) continue;
          try {
            const evt = JSON.parse(data);
            chunks += 1;
            if (evt.usage) usage = evt.usage;
            const delta = evt.choices?.[0]?.delta;
            if (delta?.content) content += delta.content;
          } catch {
            /* 忽略半包 */
          }
        }
      }
    }
    return { ok: true, status: res.status, ms: Math.round(performance.now() - t0), chunks, usage, content, sawDone };
  } finally {
    clearTimeout(timer);
  }
}

function shortErr(r) {
  if (!r) return 'no response';
  const msg =
    r.json?.error?.message ||
    r.json?.message ||
    r.json?.error ||
    (r.text ? String(r.text).slice(0, 300) : '') ||
    `HTTP ${r.status}`;
  return String(msg).replace(/\s+/g, ' ').slice(0, 220);
}

const FILLER =
  'The quick brown fox jumps over the lazy dog while the backend service retries a transient network error. ';

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: 'Return the current local time for an IANA time zone.',
      parameters: {
        type: 'object',
        properties: {
          time_zone: { type: 'string', description: 'IANA time zone, e.g. Asia/Shanghai' },
        },
        required: ['time_zone'],
        additionalProperties: false,
      },
    },
  },
];

async function runProvider(p) {
  if (!p.key) {
    console.log(`${C.yellow}跳过 ${p.label}：未设置 ${p.id.toUpperCase()}_API_KEY${C.reset}`);
    return;
  }
  console.log(`\n${C.cyan}▶ ${p.label}${C.reset}  ${C.dim}${endpoint(p)}  model=${p.model}${C.reset}`);

  // 1. 基础非流式
  {
    const r = await postJson(p, {
      model: p.model,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      max_tokens: 16,
      temperature: 0,
    });
    const content = r.json?.choices?.[0]?.message?.content ?? '';
    record(p, '1. 非流式补全', r.ok && !!content, r.ok ? `usage=${fmtUsage(r.json?.usage)}` : shortErr(r), r.ms);
  }

  // 2. 工具声明
  let toolCallMsg = null;
  {
    const r = await postJson(p, {
      model: p.model,
      messages: [{ role: 'user', content: 'What time is it in Asia/Shanghai? Use the provided tool, do not guess.' }],
      tools: TOOLS,
      tool_choice: 'auto',
      max_tokens: 512,
      temperature: 0,
    });
    const msg = r.json?.choices?.[0]?.message;
    const tc = msg?.tool_calls?.[0];
    let ok = false;
    let detail = shortErr(r);
    if (r.ok && tc) {
      toolCallMsg = msg;
      let argsOk = false;
      try {
        const parsed = JSON.parse(tc.function?.arguments ?? '');
        argsOk = typeof parsed?.time_zone === 'string';
      } catch {
        argsOk = false;
      }
      ok = argsOk;
      detail = `tool=${tc.function?.name} args=${String(tc.function?.arguments).slice(0, 80)}`;
      if (!argsOk) detail += '  (arguments 不是合法 JSON)';
    } else if (r.ok) {
      detail = '没返回 tool_calls，模型直接回答了：' + String(msg?.content ?? '').slice(0, 120);
    }
    record(p, '2. function tools', ok, detail, r.ms);
  }

  // 3. 工具结果回填
  if (toolCallMsg) {
    const r = await postJson(p, {
      model: p.model,
      messages: [
        { role: 'user', content: 'What time is it in Asia/Shanghai? Use the provided tool, do not guess.' },
        { role: 'assistant', content: toolCallMsg.content ?? null, tool_calls: toolCallMsg.tool_calls },
        {
          role: 'tool',
          tool_call_id: toolCallMsg.tool_calls[0].id,
          content: JSON.stringify({ time_zone: 'Asia/Shanghai', local_time: '2026-11-05 19:40 +08:00' }),
        },
      ],
      tools: TOOLS,
      max_tokens: 512,
      temperature: 0,
    });
    const content = r.json?.choices?.[0]?.message?.content ?? '';
    record(p, '3. tool 结果回填', r.ok && !!content, r.ok ? String(content).replace(/\s+/g, ' ').slice(0, 120) : shortErr(r), r.ms);
  } else {
    record(p, '3. tool 结果回填', false, '跳过：上一步没有拿到 tool_calls', null);
  }

  // 4. 流式 + usage
  {
    const r = await postStream(p, {
      model: p.model,
      messages: [{ role: 'user', content: 'Count from 1 to 5, separated by commas.' }],
      max_tokens: 64,
      temperature: 0,
      stream_options: { include_usage: true },
    });
    record(
      p,
      '4. 流式 SSE',
      r.ok && r.chunks > 0,
      r.ok ? `chunks=${r.chunks} usage=${fmtUsage(r.usage)} [DONE]=${r.sawDone}` : shortErr(r),
      r.ms,
    );
  }

  // 5. 前缀缓存：同一长前缀发两次
  {
    const longSystem = `You are a terse assistant. Reference material follows.\n\n${FILLER.repeat(40)}`;
    const body = {
      model: p.model,
      messages: [
        { role: 'system', content: longSystem },
        { role: 'user', content: 'Reply with the single word: ACK' },
      ],
      max_tokens: 8,
      temperature: 0,
    };
    await postJson(p, body);
    await new Promise((r) => setTimeout(r, 1500));
    const r2 = await postJson(p, body);
    const hit = cachedTokens(r2.json?.usage);
    const total = r2.json?.usage?.prompt_tokens ?? r2.json?.usage?.input_tokens ?? null;
    record(
      p,
      '5. 前缀缓存命中',
      r2.ok && (hit ?? 0) > 0,
      r2.ok ? `cached=${hit ?? 0} / prompt=${total ?? '?'}` : shortErr(r2),
      r2.ms,
    );
  }
}

function cachedTokens(usage) {
  if (!usage) return null;
  const candidates = [
    usage.prompt_cache_hit_tokens,
    usage.prompt_tokens_details?.cached_tokens,
    usage.input_tokens_details?.cached_tokens,
    usage.cached_tokens,
  ];
  for (const v of candidates) if (typeof v === 'number') return v;
  return null;
}

function fmtUsage(usage) {
  if (!usage) return 'none';
  const pt = usage.prompt_tokens ?? usage.input_tokens ?? '?';
  const ct = usage.completion_tokens ?? usage.output_tokens ?? '?';
  const hit = cachedTokens(usage);
  return hit == null ? `${pt}/${ct}` : `${pt}/${ct} cached=${hit}`;
}

function printTable() {
  const rows = results.filter((r) => r);
  const wProv = Math.max(...rows.map((r) => r.provider.length), 8);
  const wTest = Math.max(...rows.map((r) => r.test.length), 6);
  console.log(`\n${C.cyan}${'='.repeat(96)}${C.reset}`);
  for (const r of rows) {
    const mark = r.ok ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`;
    const ms = r.ms == null ? '   -' : String(r.ms).padStart(5);
    console.log(
      `${mark}  ${r.provider.padEnd(wProv)}  ${r.test.padEnd(wTest)}  ${ms}ms  ${C.dim}${r.detail}${C.reset}`,
    );
  }
  console.log(`${C.cyan}${'='.repeat(96)}${C.reset}`);

  // 结论
  const byId = new Map();
  for (const r of rows) {
    if (!byId.has(r.id)) byId.set(r.id, []);
    byId.get(r.id).push(r);
  }
  console.log('');
  for (const [id, list] of byId) {
    const fail = list.filter((r) => !r.ok);
    const label = list[0].provider;
    if (!fail.length) {
      console.log(`${C.green}✓ ${label}：全部通过，可以直接接入${C.reset}`);
    } else {
      console.log(`${C.red}✗ ${label}：${fail.length} 项失败${C.reset}`);
      for (const f of fail) console.log(`    - ${f.test}: ${f.detail}`);
    }
  }
}

console.log(`${C.cyan}DeepSeek ⇄ Ollama 兼容性冒烟测试${C.reset}  ${C.dim}node ${process.version}${C.reset}`);
console.log(`${C.dim}注意：每次运行会产生少量真实费用（约 $0.01 级别）${C.reset}`);

for (const p of providers) {
  try {
    await runProvider(p);
  } catch (err) {
    record(p, '0. 连接', false, String(err?.message || err).slice(0, 200), null);
  }
}

printTable();

const hardFail = results.some((r) => !r.ok && (r.test.startsWith('1.') || r.test.startsWith('2.')));
process.exit(hardFail ? 1 : 0);
