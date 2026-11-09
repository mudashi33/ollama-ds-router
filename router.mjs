#!/usr/bin/env node
/**
 * router.mjs —— 按北京时间把 OpenAI 兼容请求转发给更便宜的一家
 *
 *   DSH ──► http://127.0.0.1:8788/v1  ──►  DeepSeek 官方 / Ollama Cloud
 *
 * 规则来自 schedule.mjs：工作日 09:00–12:00、14:00–18:00（北京时间）走 Ollama，
 * 其余时间走 DeepSeek 官方；主线路失败（429/5xx/连不上/首字节超时）自动回退另一家。
 *
 * 启动（PowerShell）：
 *   $env:DEEPSEEK_API_KEY="sk-..."; $env:OLLAMA_API_KEY="..."; node router.mjs
 *
 * 自检：浏览器打开 http://127.0.0.1:8788/_router/status
 * 强制某家（测试用）：请求头 x-router-force: deepseek | ollama，或 ?force=ollama
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pickProvider,
  transitions,
  beijingParts,
  isDeepSeekPeak,
  isOllamaPeak,
  setHolidays,
  getHolidays,
  beijingDateKey,
} from './schedule.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------ 配置

const cfg = {
  host: process.env.ROUTER_HOST || '127.0.0.1',
  port: Number(process.env.ROUTER_PORT || 8788),
  // 上游若是挂了，等 3 分钟才报错对用户太难受：默认 60 秒拿不到首字节就换家
  firstByteTimeoutMs: Number(process.env.ROUTER_FIRST_BYTE_TIMEOUT_MS || 60000),
  // 流式/长响应期间上游「突然不说话」的容忍时间（每读到一块就重新计时）
  idleTimeoutMs: Number(process.env.ROUTER_IDLE_TIMEOUT_MS || 120000),
  bodyLimitBytes: 64 * 1024 * 1024,
  upstreams: {
    deepseek: {
      id: 'deepseek',
      label: 'DeepSeek 官方',
      base: (process.env.DEEPSEEK_BASE || 'https://api.deepseek.com').replace(/\/+$/, ''),
      key: process.env.DEEPSEEK_API_KEY || '',
      model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
    },
    ollama: {
      id: 'ollama',
      label: 'Ollama Cloud',
      base: (process.env.OLLAMA_BASE || 'https://ollama.com/v1').replace(/\/+$/, ''),
      key: process.env.OLLAMA_API_KEY || '',
      model: process.env.OLLAMA_MODEL || 'deepseek-v4.1-flash',
    },
  },
};

// ------------------------------------------------------------------ 运行模式
//
// 四种模式（顺序 = 托盘菜单顺序）：
//   auto-ds      自动 · 以 DS 空闲为准：DeepSeek 高峰 → Ollama，其余（含两家都空闲）→ 官方
//   auto-ollama  自动 · 以 Ollama 空闲为准：Ollama 高峰 → 官方，其余（含两家都空闲）→ Ollama
//   ollama       强制 Ollama（不看时间）
//   deepseek     强制 DeepSeek 官方（不看时间）
//
// 模式存在 mode.json，改完立即生效（下一个请求就按新模式走），不需要重启。

const MODES = {
  'auto-ds': { label: '自动 · 以 DS 空闲为准', kind: 'auto', preferIdle: 'deepseek' },
  'auto-ollama': { label: '自动 · 以 Ollama 空闲为准', kind: 'auto', preferIdle: 'ollama' },
  ollama: { label: '强制 Ollama', kind: 'force', provider: 'ollama' },
  deepseek: { label: '强制 DeepSeek 官方', kind: 'force', provider: 'deepseek' },
};
const MODE_ORDER = ['auto-ds', 'auto-ollama', 'ollama', 'deepseek'];
const MODE_FILE = process.env.ROUTER_MODE_FILE || path.join(HERE, 'mode.json');

/** 容错：auto / ds / ollama优先 之类的写法都认 */
function normalizeMode(input) {
  const k = String(input ?? '').trim().toLowerCase();
  if (MODES[k]) return k;
  if (k === 'auto' || k === 'ds' || k === 'auto-ds' || k === 'auto_deepseek') return 'auto-ds';
  if (k === 'auto-ollama' || k === 'auto_ollama' || k === 'o') return 'auto-ollama';
  return null;
}

function readMode() {
  try {
    return normalizeMode(JSON.parse(fs.readFileSync(MODE_FILE, 'utf8'))?.mode) || 'auto-ds';
  } catch {
    return 'auto-ds';
  }
}

function writeMode(m) {
  try {
    fs.writeFileSync(MODE_FILE, JSON.stringify({ mode: m, at: new Date().toISOString() }, null, 2));
    return true;
  } catch (err) {
    log(`模式写入失败：${err.message}`);
    return false;
  }
}

let mode = readMode();

// ------------------------------------------------------------------ 时钟与计费

// 测试用：把"现在"整体平移，便于在任意时刻验证切换逻辑
const clockOffsetMs = Number(process.env.ROUTER_CLOCK_OFFSET_MS || 0);
const now = () => new Date(Date.now() + clockOffsetMs);

const FX_USD_CNY = Number(process.env.ROUTER_FX_USD_CNY || 7.1);
const cny = (usdPerToken) => usdPerToken * FX_USD_CNY;

// 元 / token（官方页面的"每百万 token 价 ÷ 1e6"）
// DeepSeek：高峰 未命中 2 / 命中 0.04 / 输出 8，空闲为一半
// Ollama  ：高峰 0.30 / 0.006 / 1.20 美元，空闲为一半
const PRICES = {
  deepseek: {
    peak: { miss: 2 / 1e6, hit: 0.04 / 1e6, out: 8 / 1e6 },
    off: { miss: 1 / 1e6, hit: 0.02 / 1e6, out: 4 / 1e6 },
  },
  ollama: {
    peak: { miss: cny(0.3 / 1e6), hit: cny(0.006 / 1e6), out: cny(1.2 / 1e6) },
    off: { miss: cny(0.15 / 1e6), hit: cny(0.003 / 1e6), out: cny(0.6 / 1e6) },
  },
};

const emptyStats = () => ({ requests: 0, ok: 0, failed: 0, prompt: 0, cached: 0, completion: 0, costCny: 0 });
const stats = {
  startedAt: new Date().toISOString(),
  requests: 0,
  ok: 0,
  failed: 0,
  fallbacks: 0,
  actualCny: 0,
  // 手动测试请求（带 x-router-force 头）单独统计，避免把"省了多少"搅成负数
  probeRequests: 0,
  probeCny: 0,
  byProvider: { deepseek: emptyStats(), ollama: emptyStats() },
  // 每一档实际被请求了多少次：用来证明 DSH 选的那档真的下发到了上游
  byEffort: {},
  last: null,
  lastEffort: null,
};

// ------------------------------------------------------------------ 最近请求（环形缓冲）
//
// 排障时最想看的是「刚才那几条为什么失败/走了谁」，聚合统计给不了。
// 只放内存，重启即清空；不落盘，避免把对话元数据写进仓库。
const RECENT_MAX = Number(process.env.ROUTER_RECENT_MAX || 20);
const recent = [];
function pushRecent(entry) {
  recent.unshift(entry);
  if (recent.length > RECENT_MAX) recent.length = RECENT_MAX;
}

/** 从请求体里读出思考开关与推理档位（DSH 按 thinkingFormat=deepseek 下发这两项） */
function effortOf(body) {
  const effort = typeof body?.reasoning_effort === 'string' ? body.reasoning_effort : null;
  const thinking = body?.thinking?.type ?? null;
  return { thinking, effort };
}

/** 日志里的一小段："思考 enabled / effort=max" */
function effortTag({ thinking, effort }) {
  if (!thinking && !effort) return '  未带思考参数';
  const bits = [];
  if (thinking) bits.push(`思考 ${thinking}`);
  if (effort) bits.push(`effort=${effort}`);
  return `  ${bits.join(' / ')}`;
}

/** 不同网关的 usage 字段名不一样，统一成 {prompt, cached, completion} */
function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const prompt = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
  const completion = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
  const cachedRaw =
    u.prompt_cache_hit_tokens ??
    u.prompt_tokens_details?.cached_tokens ??
    u.cache_read_input_tokens ??
    u.cached_tokens ??
    0;
  const cached = Math.min(Number(cachedRaw) || 0, prompt);
  if (!prompt && !completion) return null;
  return { prompt, cached, completion };
}

function costCny(provider, tier, usage) {
  if (!usage) return 0;
  const p = PRICES[provider][tier];
  const miss = Math.max(usage.prompt - usage.cached, 0);
  return miss * p.miss + usage.cached * p.hit + usage.completion * p.out;
}

const fmtTok = (n) => {
  if (!n) return '0';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
};
const fmtCny = (n) => `¥${n < 0.01 ? n.toFixed(6) : n.toFixed(4)}`;

/**
 * 记录一次成功的请求，返回本次成本。
 * `probe: true`（带 x-router-force 的手动测试请求）只单独计入 probeCny，
 * 不参与"省了多少"——否则测试请求会把省钱数字搅成负数。
 */
function record({ provider, tier, dsTier, usage, ms, fallback, effort, probe }) {
  const s = stats.byProvider[provider];
  const cost = usage ? costCny(provider, tier, usage) : 0;
  if (probe) {
    // 手动测试请求（x-router-force）：只记次数与花费，不进"省了多少"，也不进历史账本
    stats.probeRequests++;
    stats.probeCny += cost;
  } else {
    stats.requests++;
    stats.ok++;
    s.requests++;
    s.ok++;
  }
  if (fallback && !probe) stats.fallbacks++;
  const key = effort?.effort || (effort?.thinking === 'disabled' ? 'off' : '未指定');
  stats.byEffort[key] = (stats.byEffort[key] || 0) + 1;
  if (usage && !probe) {
    s.prompt += usage.prompt;
    s.cached += usage.cached;
    s.completion += usage.completion;
    s.costCny += cost;
    stats.actualCny += cost;
    stats.last = { at: new Date().toISOString(), provider, ms, usage, costCny: cost, effort };
  }
  if (!probe) addToDay(beijingDateKey(now()), { provider, usage, cost });
  // 无论上游有没有回 usage，都记下"这一次请求的思考档位"——这是证明档位真的下发的凭据
  stats.lastEffort = { at: new Date().toISOString(), provider, ...effort };
  return { cost };
}

// ------------------------------------------------------------------ 历史账本

// 按北京日期分桶写进 stats.json，重启不清零，看板才能回答"这个月省了多少"
const STATS_FILE = process.env.ROUTER_STATS_FILE || path.join(HERE, 'stats.json');
const history = { days: {} };
const zeroDay = () => ({
  requests: 0,
  ok: 0,
  failed: 0,
  prompt: 0,
  cached: 0,
  completion: 0,
  costCny: 0,
  byProvider: {
    deepseek: { requests: 0, prompt: 0, cached: 0, completion: 0, costCny: 0 },
    ollama: { requests: 0, prompt: 0, cached: 0, completion: 0, costCny: 0 },
  },
});

function loadHistory() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') log(`历史账本读取失败（已忽略）：${err.message}`);
    return;
  }
  if (raw && raw.days && typeof raw.days === 'object') history.days = raw.days;
  // 账本按天分桶，永远只增不减；一年就是 365 个桶，留着够看，再旧的就裁掉
  const keepDays = Number(process.env.ROUTER_STATS_KEEP_DAYS || 365);
  const keys = Object.keys(history.days).sort();
  const drop = keys.slice(0, Math.max(0, keys.length - keepDays));
  for (const k of drop) delete history.days[k];
  if (drop.length) log(`历史账本裁剪：删掉 ${drop.length} 天旧数据（保留 ${keepDays} 天）`);
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(STATS_FILE, `${JSON.stringify({ version: 1, days: history.days }, null, 2)}\n`);
    } catch (err) {
      log(`历史账本写入失败：${err.message}`);
    }
  }, 1500);
  if (saveTimer.unref) saveTimer.unref();
}

function addToDay(day, { provider, usage, cost }) {
  const d = (history.days[day] ||= zeroDay());
  d.requests++;
  d.ok++;
  d.costCny += cost;
  const p = (d.byProvider[provider] ||= { requests: 0, prompt: 0, cached: 0, completion: 0, costCny: 0 });
  p.requests++;
  p.costCny += cost;
  if (usage) {
    d.prompt += usage.prompt;
    d.cached += usage.cached;
    d.completion += usage.completion;
    p.prompt += usage.prompt;
    p.cached += usage.cached;
    p.completion += usage.completion;
  }
  scheduleSave();
}

function sumDays(keys) {
  const t = zeroDay();
  for (const k of keys) {
    const d = history.days[k];
    if (!d) continue;
    for (const f of ['requests', 'ok', 'failed', 'prompt', 'cached', 'completion', 'costCny']) {
      t[f] += d[f] || 0;
    }
    for (const id of ['deepseek', 'ollama']) {
      const s = (d.byProvider && d.byProvider[id]) || {};
      const o = t.byProvider[id];
      for (const f of ['requests', 'prompt', 'cached', 'completion', 'costCny']) o[f] += s[f] || 0;
    }
  }
  return t;
}

/** 给一段账目补上"共用了多少 token"的合计，方便看板直接显示 */
const view = (t) => ({
  ...t,
  costCny: Number(t.costCny.toFixed(6)),
  tokens: { input: t.prompt, cached: t.cached, output: t.completion },
});

function historyView(span = 7) {
  const at = now();
  const keys = [];
  for (let i = span - 1; i >= 0; i--) keys.push(beijingDateKey(new Date(at.getTime() - i * 86400000)));
  const todayKey = beijingDateKey(at);
  return {
    today: view(history.days[todayKey] || zeroDay()),
    last7: view(sumDays(keys)),
    total: view(sumDays(Object.keys(history.days))),
    days: keys.filter((k) => history.days[k]?.requests).map((k) => ({ date: k, ...view(history.days[k]) })),
  };
}

function statsView() {
  return {
    ...stats,
    effortNote: 'effort 取自请求体 reasoning_effort，thinking 取自 thinking.type，原样下发给上游',
    actualCny: Number(stats.actualCny.toFixed(6)),
    probeCny: Number(stats.probeCny.toFixed(6)),
    fxUsdCny: FX_USD_CNY,
    tokens: {
      input: Object.values(stats.byProvider).reduce((n, s) => n + s.prompt, 0),
      cached: Object.values(stats.byProvider).reduce((n, s) => n + s.cached, 0),
      output: Object.values(stats.byProvider).reduce((n, s) => n + s.completion, 0),
    },
    history: historyView(),
  };
}

/** 从响应体（普通 JSON 或 SSE）里抠出最后一个 usage 对象 */
function parseUsage(text) {
  if (!text) return null;
  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  const whole = tryParse(text.trim());
  if (whole?.usage) return whole.usage;

  let last = null;
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('data:')) continue;
    const payload = s.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    const obj = tryParse(payload);
    if (obj?.usage) last = obj.usage;
  }
  return last;
}

// 可回退的上游状态：限流、网关故障，以及"这个参数我不认"这类 400/404/422
// （同一模型换一家网关时，参数方言差异是最常见的失败原因，回退一次通常就好了）
const RETRYABLE_STATUS = new Set([400, 404, 408, 409, 422, 425, 429, 500, 502, 503, 504, 529]);

// 上下文溢出必须原样透传，不能换家重试、也不能兜底成 503：
// 客户端（DeepSeek Harness 等）靠错误文本判断"该压缩上下文了"，换家重试只会再失败一次，
// 兜底成 503 则会把可恢复的溢出变成一条无法诊断的"所有上游都失败了"。
// 这里的正则与客户端侧的溢出识别保持一致，覆盖 OpenAI/DeepSeek/Ollama/vLLM 等常见措辞。
const OVERFLOW_PATTERNS = [
  /maximum context length/i,
  /context[_ ]length[_ ]exceeded/i,
  /prompt (?:is )?too long/i,
  /prompt too long/i,
  /exceeds? the (?:model'?s )?context window/i,
  /exceeds the maximum (?:allowed )?input length/i,
  /too many tokens/i,
  /token limit exceeded/i,
  /input is too long/i,
  /reduce the length of the messages/i,
];

/** 上游的错误正文是否表示"上下文超长"（这类失败重试无意义，必须让客户端看到原文）。 */
function isContextOverflow(text) {
  return OVERFLOW_PATTERNS.some((re) => re.test(text));
}

/** 宽松 JSON 解析：上游的错误正文不一定是 JSON，解析失败一律返回 null。 */
function safeJsonParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// 允许从旧模型名自动映射到当前 provider 的模型名
const ALIASES = new Set([
  'auto',
  'deepseek-flash',
  'deepseek-chat',
  'deepseek-v4.1-flash',
  'deepseek-v4.1-flash:cloud',
  'deepseek-v4.1-flash:1017-cloud',
]);

// ------------------------------------------------------------------ 工具

const pad = (n) => String(n).padStart(2, '0');
const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function clock(date = new Date()) {
  const b = beijingParts(date);
  return `${WEEKDAY_CN[b.weekday]} ${pad(b.hours)}:${pad(b.mins)}`;
}

function log(msg) {
  const d = new Date();
  console.log(`[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}] ${msg}`);
}

function available(id) {
  return Boolean(cfg.upstreams[id]?.key);
}

function choose(force) {
  if (force && available(force)) {
    return { provider: force, reason: '请求强制指定', forced: true, mode };
  }
  const m = MODES[mode];
  if (m.kind === 'force') {
    if (available(m.provider)) return { provider: m.provider, reason: `模式：${m.label}`, mode };
    const other = m.provider === 'ollama' ? 'deepseek' : 'ollama';
    if (available(other)) {
      return { provider: other, reason: `模式：${m.label}，但 ${m.provider} 未配置 key，改用 ${other}`, mode };
    }
  }
  const p = pickProvider(now(), { preferIdle: m.kind === 'auto' ? m.preferIdle : 'deepseek' });
  if (!available(p.provider)) {
    const other = p.provider === 'ollama' ? 'deepseek' : 'ollama';
    if (available(other)) {
      return { ...p, provider: other, reason: `${p.reason}，但 ${p.provider} 未配置 key，改用 ${other}`, mode };
    }
  }
  return { ...p, mode };
}

/**
 * 当前模式下「下次自动切换」的信息（强制模式不会自动切换）。
 * 返回值：{ forced, at?, provider?, text }
 */
function nextSwitch(at = now()) {
  const md = MODES[mode];
  if (md.kind !== 'auto') return { forced: true, text: '强制模式：不自动切换' };
  const t = transitions(at, 48, { preferIdle: md.preferIdle })[1];
  if (!t) return { forced: false, text: '48 小时内无' };
  return { forced: false, at: t.at, provider: t.provider, text: `${clock(t.at)} → ${cfg.upstreams[t.provider].label}` };
}

function mapModel(requested, upstream) {
  if (!requested || requested === 'auto') return upstream.model;
  if (ALIASES.has(requested)) return upstream.model;
  return requested; // 用户明确指定了别的模型，原样透传
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('request body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj, null, 2));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

// ------------------------------------------------------------------ 上游调用

/**
 * 尝试一个上游。返回 { ok:true } 表示已经把响应（含流）写给客户端；
 * 返回 { ok:false, retryable, reason } 表示还没写任何字节，可以换一家重试。
 */
async function attempt(upstream, payload, res, opts = {}) {
  const url = `${upstream.base}/chat/completions`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('首字节超时')), cfg.firstByteTimeoutMs);
  const t0 = Date.now();

  let upstreamRes;
  try {
    upstreamRes = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${upstream.key}`,
      },
      body: payload,
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, retryable: true, reason: `连接失败: ${err?.message || err}`, ms: Date.now() - t0 };
  }
  clearTimeout(timer); // 已拿到响应头，后续流式不再设整段超时

  if (!upstreamRes.ok) {
    const text = await upstreamRes.text().catch(() => '');
    const overflow = isContextOverflow(text);
    return {
      ok: false,
      // 上下文溢出重试无意义（换一家还是同样的输入超长），必须直接透传给客户端
      retryable: overflow ? false : RETRYABLE_STATUS.has(upstreamRes.status),
      overflow,
      reason: `HTTP ${upstreamRes.status} ${text.slice(0, 200).replace(/\s+/g, ' ')}`,
      status: upstreamRes.status,
      body: text,
      ms: Date.now() - t0,
    };
  }

  // 响应头等第一块数据到了再写（见下面的 markSent）。这样上游在首字节之前就断流
  // （比如它对图片/参数直接报错并掐连接）时，还没给客户端吐过任何字节，可以安全地换另一家重试。
  // 注意：Node 的 fetch 已经把 body 解压了，绝不能再把 content-encoding 传给客户端，
  // 否则客户端会拿明文当 gzip 解，流就会「提前结束」。content-length 同理不透传。
  const headers = {
    'content-type': upstreamRes.headers.get('content-type') || 'application/json',
    'x-router-provider': upstream.id,
    'x-router-model': upstream.model,
  };
  let sent = false;
  const markSent = () => {
    if (sent) return;
    sent = true;
    res.writeHead(upstreamRes.status, headers);
    opts.onFirstByte?.();
  };

  if (!upstreamRes.body) {
    markSent();
    res.end();
    return { ok: true, ms: Date.now() - t0 };
  }

  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder();
  let tail = '';
  // 响应头到了之后原来的「首字节计时器」就撤了。但上游可能在中途卡死不吐数据
  // （尤其长思考 + 流式），没有超时的话请求会永远挂着。这里每读到一块就重置一次。
  let idleTimer = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ac.abort(new Error(`上游 ${Math.round(cfg.idleTimeoutMs / 1000)}s 没有新数据`)), cfg.idleTimeoutMs);
    if (idleTimer.unref) idleTimer.unref();
  };
  const disarmIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  try {
    while (true) {
      armIdle();
      const { done, value } = await reader.read();
      disarmIdle();
      if (done) break;
      markSent();
      res.write(value);
      // 只留尾部：usage 总在流的最后，没必要缓存整个响应
      tail += decoder.decode(value, { stream: true });
      if (tail.length > 256 * 1024) tail = tail.slice(-256 * 1024);
    }
  } catch (err) {
    if (!sent) {
      // 一个字节都没发出去，交给上层换一家
      return { ok: false, retryable: true, reason: `流在首字节前中断: ${err?.message || err}`, ms: Date.now() - t0 };
    }
    log(`  流中断: ${err?.message || err}`);
  } finally {
    disarmIdle();
  }
  markSent();
  tail += decoder.decode();
  res.end();
  return { ok: true, ms: Date.now() - t0, usage: parseUsage(tail) };
}

// ------------------------------------------------------------------ 节假日

/** 读取 holidays.json（数组或 {"holidays":[...]}），缺失就当作没有节假日 */
function loadHolidays() {
  const file = process.env.ROUTER_HOLIDAYS_FILE || path.join(HERE, 'holidays.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') log(`节假日表读取失败（已忽略）：${err.message}`);
    return;
  }
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.holidays) ? raw.holidays : [];
  const valid = list.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d)));
  if (valid.length !== list.length) log(`节假日表有 ${list.length - valid.length} 条格式不对，已跳过`);
  setHolidays(valid);
  if (valid.length) log(`节假日表：${valid.length} 天（这些天 DeepSeek 官方全天空闲）`);
}

// 上游账户余额（60 秒缓存；失败不影响主链路）
const BALANCE_PATHS = { deepseek: '/user/balance', ollama: '/api/balance' };
const balanceCache = new Map();

async function upstreamBalance(id) {
  const u = cfg.upstreams[id];
  if (!u.key) return { ok: false, error: `未配置 ${id.toUpperCase()}_API_KEY` };
  const hit = balanceCache.get(id);
  if (hit && Date.now() - hit.at < 60000) return hit.value;
  let value;
  try {
    const origin = new URL(u.base).origin;
    const r = await fetch(`${origin}${BALANCE_PATHS[id]}`, {
      headers: { authorization: `Bearer ${u.key}` },
      signal: AbortSignal.timeout(8000),
    });
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text.slice(0, 500);
    }
    value = { ok: r.ok, status: r.status, data, checkedAt: new Date().toISOString() };
  } catch (err) {
    value = { ok: false, error: String(err?.message || err), checkedAt: new Date().toISOString() };
  }
  balanceCache.set(id, { at: Date.now(), value });
  return value;
}

const allBalances = async () => ({
  deepseek: await upstreamBalance('deepseek'),
  ollama: await upstreamBalance('ollama'),
});

// ------------------------------------------------------------------ 看板

function sendHtml(res, html) {
  const body = Buffer.from(html);
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** 浏览器直接打开 http://127.0.0.1:8788/ 看到的那一页 */
async function dashboardHtml() {
  const at = now();
  const p = choose();
  const next = nextSwitch(at);
  const v = statsView();
  const h = v.history;
  const bal = await allBalances();
  const money = (n) => `¥${Number(n).toFixed(6)}`;
  const le = v.lastEffort;
  const effortView = le ? (le.effort || (le.thinking === 'disabled' ? 'off' : '未指定')) : '还没有请求';
  const effortSub = le
    ? `thinking=${le.thinking || '未带'} · ${cfg.upstreams[le.provider].label} · ${new Date(le.at).toLocaleTimeString('zh-CN', { hour12: false })}` +
      `　各档累计：${Object.entries(v.byEffort).map(([k, n]) => `${k}×${n}`).join(' / ')}`
    : '在 DSH 里选一档推理等级，发一句话就能看到';
  const rows = Object.entries(v.byProvider)
    .map(
      ([id, s]) =>
        `<tr><td>${cfg.upstreams[id].label}</td><td>${s.requests}</td><td>${s.prompt.toLocaleString()}</td>` +
        `<td>${s.cached.toLocaleString()}</td><td>${s.completion.toLocaleString()}</td><td>${money(s.costCny)}</td></tr>`,
    )
    .join('');
  // 余额：两家各一张卡，只显示"还剩多少钱"
  const balOf = (() => {
    const ds = bal.deepseek;
    const ol = bal.ollama;
    let dsCard;
    if (ds?.ok) {
      const infos = Array.isArray(ds.data?.balance_infos) ? ds.data.balance_infos : [];
      const cny = infos.find((x) => x.currency === 'CNY');
      const usd = infos.find((x) => x.currency === 'USD');
      const one = cny || usd;
      dsCard = one
        ? { value: `${one.currency === 'CNY' ? '¥' : '$'}${Number(one.total_balance).toFixed(2)}`, sub: `充值 ${one.currency === 'CNY' ? '¥' : '$'}${Number(one.topped_up_balance ?? 0).toFixed(2)} · 赠送 ¥${Number(one.granted_balance ?? 0).toFixed(2)}` }
        : { value: '—', sub: JSON.stringify(ds.data).slice(0, 60) };
    } else {
      dsCard = { value: '取不到', sub: String(ds?.error || `HTTP ${ds?.status}`) };
    }
    let olCard;
    const inc = ol?.data?.included;
    if (ol?.ok && inc) {
      const pur = Number(ol.data?.purchased?.balance_usd || 0);
      olCard = {
        value: `$${Number(inc.balance_usd).toFixed(2)}`,
        sub: `套餐 $${Number(inc.allowance_usd).toFixed(0)}${pur ? ` · 另购 $${pur.toFixed(2)}` : ''}` +
          (inc.period?.until ? ` · 到 ${String(inc.period.until).slice(0, 10)}` : ''),
      };
    } else if (ol?.ok) {
      olCard = { value: '—', sub: JSON.stringify(ol.data).slice(0, 60) };
    } else {
      olCard = { value: '取不到', sub: String(ol?.error || `HTTP ${ol?.status}`) };
    }
    return { deepseek: dsCard, ollama: olCard };
  })();
  const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const tokLine = (t) => `输入 ${tok(t.input)}（缓存 ${tok(t.cached)}）· 输出 ${tok(t.output)}`;
  // auto 背后两家各用了多少：按 今日 / 近 7 天 / 累计 分列（DSH 插件只能看到 time-router:auto 一行，拆分看这里）
  const periods = [['今日（北京）', h.today], ['近 7 天', h.last7], ['累计', h.total]];
  const cellOf = (t, id) => {
    const s = (t.byProvider && t.byProvider[id]) || {};
    const tk = (s.prompt || 0) + (s.completion || 0);
    return `<td>${s.requests || 0} 次<br><span class="dim">${tok(tk)} token</span><br>${money(s.costCny || 0)}</td>`;
  };
  const upRows = Object.keys(cfg.upstreams)
    .map((id) => `<tr><td>${cfg.upstreams[id].label}</td>${periods.map(([, t]) => cellOf(t, id)).join('')}</tr>`)
    .join('');
  const upTotal = `<tr><td>合计</td>${periods
    .map(([, t]) => `<td>${t.requests} 次<br><span class="dim">${tok(t.tokens.input + t.tokens.output)} token</span><br>${money(t.costCny)}</td>`)
    .join('')}</tr>`;
  // 每家花了多少：只列真正有请求的那几家
  const split = (t) =>
    Object.entries(t.byProvider || {})
      .filter(([, s]) => s?.requests)
      .map(([id, s]) => `${cfg.upstreams[id]?.label ?? id} ${s.requests} 次 ${money(s.costCny)}`)
      .join(' · ');
  // 最近请求：聚合数字回答不了「刚才那条为什么失败」，这里给个短列表
  const recentRows = recent
    .slice(0, 10)
    .map((e) => {
      const t = e.at ? new Date(e.at) : null;
      const hhmm = t
        ? `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`
        : '';
      const result = e.ok ? '<span style="color:#4ade80">✓</span>' : `<span style="color:#f87171">✗ ${e.status ?? ''}</span>`;
      const tk = (e.prompt ?? 0) + (e.completion ?? 0);
      const detail = e.ok
        ? `${tok(tk)} · ${money(e.costCny || 0)}`
        : `<span class="dim">${String(e.reason || '').slice(0, 70)}</span>`;
      return `<tr><td>${hhmm}</td><td>${e.upstream}</td><td>${result}</td><td>${e.ms ?? ''}ms</td><td>${detail}</td></tr>`;
    })
    .join('');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="5">
<title>时间路由</title>
<style>
  body{font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:0;padding:28px;
       background:#0f1115;color:#e6e6e6}
  h1{font-size:17px;font-weight:600;margin:0 0 18px;color:#9aa4b2}
  h2{font-size:13px;font-weight:500;color:#8b95a3;margin:26px 0 8px}
  .now{font-size:30px;font-weight:700;margin:0 0 4px}
  .now small{font-size:14px;font-weight:400;color:#8b95a3;margin-left:10px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:14px 0}
  .card{background:#171a21;border:1px solid #232833;border-radius:10px;padding:12px 14px}
  .card b{display:block;font-size:20px;margin-top:4px}
  .sub{display:block;color:#8b95a3;font-size:12px;margin-top:4px}
  .dim{color:#8b95a3;font-size:12px}
  .lbl{color:#8b95a3;font-size:12px}
  table{border-collapse:collapse;width:100%;margin-top:8px}
  th,td{text-align:right;padding:7px 10px;border-bottom:1px solid #232833}
  th:first-child,td:first-child{text-align:left}
  th{color:#8b95a3;font-weight:500;font-size:12px}
  a{color:#5aa9ff}
  .links{margin-top:18px;font-size:12px;color:#8b95a3}
</style></head>
<body>
  <h1>时间路由 · 每 5 秒自动刷新</h1>
  <p class="links" style="margin:-12px 0 14px">当前模式：<b style="color:#e6e6e6">${MODES[mode].label}</b>
    · <a href="/_router/prefer?prefer=auto-ds">自动·以 DS 空闲为准</a>
    · <a href="/_router/prefer?prefer=auto-ollama">自动·以 Ollama 空闲为准</a>
    · <a href="/_router/prefer?prefer=ollama">强制 Ollama</a>
    · <a href="/_router/prefer?prefer=deepseek">强制官方</a></p>
  <p class="now">${cfg.upstreams[p.provider].label}<small>模型 ${cfg.upstreams[p.provider].model} · ${p.reason}</small></p>
  <div class="grid">
    <div class="card"><span class="lbl">北京时间</span><b>${clock(at)}</b>
      <span class="sub">下次切换：${next.text}</span>
      <span class="sub">DeepSeek 高峰：工作日 09:00–12:00、14:00–18:00${isDeepSeekPeak(at) ? '（现在就是）' : ''}</span>
      <span class="sub">Ollama 高峰：工作日 20:00–次日 02:00${isOllamaPeak(at) ? '（现在就是）' : ''}</span></div>
    <div class="card"><span class="lbl">推理档位（最近一次请求）</span><b>${effortView}</b>
      <span class="sub">${effortSub}</span></div>
    <div class="card"><span class="lbl">本次运行 · 花费</span><b>${money(v.actualCny)}</b>
      <span class="sub">${v.requests} 次请求${v.probeCny > 0 ? `，另有测试 ${v.probeRequests} 次 ${money(v.probeCny)}` : ''}</span>
      <span class="sub">${split({ byProvider: v.byProvider })}</span></div>
    <div class="card"><span class="lbl">本次运行 · token</span><b>${tok(v.tokens.input + v.tokens.output)}</b>
      <span class="sub">${tokLine(v.tokens)}</span></div>
  </div>

  <h2>还剩多少钱</h2>
  <div class="grid">
    <div class="card"><span class="lbl">DeepSeek 官方余额</span><b>${balOf.deepseek.value}</b>
      <span class="sub">${balOf.deepseek.sub}</span></div>
    <div class="card"><span class="lbl">Ollama 剩余额度</span><b>${balOf.ollama.value}</b>
      <span class="sub">${balOf.ollama.sub}</span></div>
  </div>

  <h2>用了多少 / 花了多少</h2>
  <div class="grid">
    <div class="card"><span class="lbl">今日（北京）</span><b>${money(h.today.costCny)}</b>
      <span class="sub">${h.today.requests} 次 · ${tokLine(h.today.tokens)}</span>
      <span class="sub">${split(h.today)}</span></div>
    <div class="card"><span class="lbl">近 7 天</span><b>${money(h.last7.costCny)}</b>
      <span class="sub">${h.last7.requests} 次 · ${tokLine(h.last7.tokens)}</span>
      <span class="sub">${split(h.last7)}</span></div>
    <div class="card"><span class="lbl">累计（含以往运行）</span><b>${money(h.total.costCny)}</b>
      <span class="sub">${h.total.requests} 次 · ${tokLine(h.total.tokens)}</span>
      <span class="sub">${split(h.total)}</span></div>
  </div>

  <h2>按上游：auto 背后两家的用量与花费</h2>
  <table>
    <tr><th>上游</th>${periods.map(([label]) => `<th>${label}</th>`).join('')}</tr>
    ${upRows}
    ${upTotal}
  </table>

  <h2>本次运行 · 分上游明细</h2>
  <table>
    <tr><th>上游</th><th>请求</th><th>输入 token</th><th>其中缓存命中</th><th>输出 token</th><th>花费</th></tr>
    ${rows || '<tr><td colspan="6">还没有请求经过这里</td></tr>'}
  </table>
  <h2>最近请求（最多 ${RECENT_MAX} 条，只放内存）</h2>
  <table>
    <tr><th>时间</th><th>上游</th><th>结果</th><th>耗时</th><th>输入+输出 / 失败原因</th></tr>
    ${recentRows || '<tr><td colspan="5">还没有请求经过这里</td></tr>'}
  </table>
  <p class="links">原始数据：<a href="/_router/status">/_router/status</a> ·
    <a href="/_router/stats">/_router/stats</a> · <a href="/_router/balance">/_router/balance</a>
    · 汇率（Ollama 美元折算）${v.fxUsdCny ?? FX_USD_CNY}</p>
</body></html>`;
}

// ------------------------------------------------------------------ 服务

loadHolidays();
loadHistory();

// holidays.json 改了不用重启：监听文件变化后重载（编辑器用「重命名替换」时会丢监听，忽略即可）
try {
  const hfile = process.env.ROUTER_HOLIDAYS_FILE || path.join(HERE, 'holidays.json');
  fs.watch(hfile, { persistent: false }, () => {
    try {
      loadHolidays();
      log(`节假日表已重载：${getHolidays().length} 天`);
    } catch (err) {
      log(`节假日表重载失败（继续用旧的）：${err.message}`);
    }
  });
} catch {
  /* 文件不存在时 watch 会抛，忽略 */
}

/** 给托盘小工具用的纯文本快照（一行一个 key=value，省得在客户端里解析 JSON） */
async function modeSnapshot() {
  const at = now();
  const p = choose();
  const next = nextSwitch(at);
  const h = statsView().history;
  const bal = await allBalances();
  const ds = bal.deepseek;
  const ol = bal.ollama;
  let dsText = '—';
  let dsOk = 0;
  if (ds?.ok) {
    const infos = Array.isArray(ds.data?.balance_infos) ? ds.data.balance_infos : [];
    const one = infos.find((x) => x.currency === 'CNY') || infos.find((x) => x.currency === 'USD');
    if (one) {
      dsText = `${one.currency === 'CNY' ? '¥' : '$'}${Number(one.total_balance).toFixed(2)}`;
      dsOk = 1;
    }
  }
  const inc = ol?.ok ? ol.data?.included : null;
  const olText = inc ? `$${Number(inc.balance_usd).toFixed(2)}` : '—';
  return [
    `mode=${mode}`,
    `label=${MODES[mode].label}`,
    `provider=${p.provider}`,
    `providerLabel=${cfg.upstreams[p.provider].label}`,
    `reason=${p.reason}`,
    `beijing=${clock(at)}`,
    `deepseekPeak=${isDeepSeekPeak(at) ? 1 : 0}`,
    `deepseekPeakWindow=工作日 09:00–12:00、14:00–18:00`,
    `ollamaPeak=${isOllamaPeak(at) ? 1 : 0}`,
    `ollamaPeakWindow=工作日 20:00–次日 02:00`,
    `nextSwitch=${next.text}`,
    `deepseekOk=${dsOk}`,
    `deepseekBalance=${dsText}`,
    `deepseekError=${dsOk ? '' : String(ds?.error || `HTTP ${ds?.status ?? '?'}`)}`,
    `ollamaOk=${inc ? 1 : 0}`,
    `ollamaBalance=${olText}`,
    `ollamaAllowance=${inc ? Number(inc.allowance_usd).toFixed(0) : ''}`,
    `ollamaUntil=${inc?.period?.until ? String(inc.period.until).slice(0, 10) : ''}`,
    `todayRequests=${h.today.requests}`,
    `todayCostCny=${Number(h.today.costCny).toFixed(4)}`,
    `requests=${stats.requests}`,
    `costCny=${Number(stats.actualCny).toFixed(4)}`,
  ].join('\n') + '\n';
}

async function handle(req, res) {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/' || url.pathname === '/_router' || url.pathname === '/_router/') {
    return sendHtml(res, await dashboardHtml());
  }

  if (url.pathname === '/_router/mode') {
    const body = Buffer.from(await modeSnapshot(), 'utf8');
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
    return res.end(body);
  }

  if (url.pathname === '/_router/prefer') {
    let raw = url.searchParams.get('prefer') || url.searchParams.get('mode');
    if (!raw && req.method === 'POST') {
      try {
        const body = await readBody(req, 64 * 1024);
        const parsed = JSON.parse(body.toString('utf8') || '{}');
        raw = parsed.prefer || parsed.mode;
      } catch {
        /* 交给下面的校验报错 */
      }
    }
    const next = normalizeMode(raw);
    if (!next) {
      return sendJson(res, 400, {
        ok: false,
        error: `不认识的模式：${raw ?? '(空)'}`,
        modes: MODE_ORDER.map((k) => ({ mode: k, label: MODES[k].label })),
      });
    }
    mode = next;
    const saved = writeMode(next);
    log(`模式切换 → ${MODES[next].label}${saved ? '' : '（写文件失败，仅内存生效）'}`);
    const p = choose();
    return sendJson(res, 200, { ok: true, mode, label: MODES[mode].label, provider: p.provider, reason: p.reason, saved });
  }

  if (url.pathname === '/_router/recent') {
    return sendJson(res, 200, { max: RECENT_MAX, count: recent.length, recent });
  }

  if (url.pathname === '/_router/status') {
    const at = now();
    const p = choose();
    const next = nextSwitch(at);
    return sendJson(res, 200, {
      now: at.toISOString(),
      beijing: clock(at),
      mode,
      modeLabel: MODES[mode].label,
      provider: p.provider,
      reason: p.reason,
      deepseekPeak: isDeepSeekPeak(at),
      ollamaPeak: isOllamaPeak(at),
      holidays: getHolidays().length,
      nextSwitch: next.at ? { at: next.at.toISOString(), beijing: clock(next.at), to: next.provider } : { text: next.text, forced: Boolean(next.forced) },
      upstreams: Object.fromEntries(
        Object.entries(cfg.upstreams).map(([id, u]) => [id, { label: u.label, base: u.base, model: u.model, hasKey: Boolean(u.key) }]),
      ),
      usage: {
        requests: stats.requests,
        actualCny: Number(stats.actualCny.toFixed(6)),
        detail: '/_router/stats',
        balance: '/_router/balance',
      },
    });
  }

  if (url.pathname === '/_router/stats') {
    return sendJson(res, 200, statsView());
  }

  if (url.pathname === '/_router/balance') {
    return sendJson(res, 200, await allBalances());
  }

  if (url.pathname === '/v1/models' || url.pathname === '/models') {
    return sendJson(res, 200, {
      object: 'list',
      data: [{ id: 'auto', object: 'model', created: 0, owned_by: 'time-router' }],
    });
  }

  const isChat =
    url.pathname === '/v1/chat/completions' ||
    url.pathname === '/chat/completions' ||
    url.pathname === '/v1/completions';
  if (!isChat) {
    return sendJson(res, 404, { error: { message: `未知路径 ${url.pathname}` } });
  }
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: { message: '只支持 POST' } });
  }

  let raw;
  try {
    raw = await readBody(req, cfg.bodyLimitBytes);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: { message: err.message } });
  }

  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return sendJson(res, 400, { error: { message: '请求体不是合法 JSON' } });
  }

  const force = String(req.headers['x-router-force'] || url.searchParams.get('force') || '').toLowerCase();
  const decision = choose(force === 'deepseek' || force === 'ollama' ? force : null);

  const first = decision.provider;
  const second = first === 'ollama' ? 'deepseek' : 'ollama';
  const order = [first, second].filter((id) => available(id));

  if (!order.length) {
    return sendJson(res, 500, {
      error: { message: '两个上游都没有配置 key：请设置 DEEPSEEK_API_KEY / OLLAMA_API_KEY' },
    });
  }

  const stream = body.stream === true;
  const effort = effortOf(body);
  const at = now();
  const dsTier = isDeepSeekPeak(at) ? 'peak' : 'off';
  const olTier = isOllamaPeak(at) ? 'peak' : 'off';
  const mtSent = body.max_tokens ?? body.max_completion_tokens;
  log(`→ ${first}  ${decision.reason}${stream ? '  [stream]' : ''}${effortTag(effort)}  max_tokens=${mtSent === undefined ? '未发送' : mtSent}  msgs=${Array.isArray(body.messages) ? body.messages.length : 0}`);

  for (const id of order) {
    const upstream = cfg.upstreams[id];
    const payload = Buffer.from(
      JSON.stringify({ ...body, model: mapModel(body.model, upstream) }),
    );
    const result = await attempt(upstream, payload, res);
    if (result.ok) {
      const usage = normalizeUsage(result.usage);
      const r = record({
        provider: id,
        tier: id === 'deepseek' ? dsTier : olTier,
        dsTier,
        usage,
        ms: result.ms,
        fallback: id !== first,
        effort,
        probe: decision.forced === true,
      });
      const tailMsg = usage
        ? `  in ${fmtTok(usage.prompt)}（缓存 ${fmtTok(usage.cached)}）/ out ${fmtTok(usage.completion)}  ${fmtCny(r.cost)}`
        : '  （上游未返回 usage）';
      log(`✓ ${upstream.label}  ${result.ms}ms${tailMsg}`);
      pushRecent({
        at: new Date().toISOString(),
        ok: true,
        provider: id,
        upstream: upstream.label,
        mode,
        stream,
        fallback: id !== first,
        effort: effort?.effort ?? null,
        ms: result.ms,
        prompt: usage?.prompt ?? null,
        cached: usage?.cached ?? null,
        completion: usage?.completion ?? null,
        costCny: Number(r?.cost || 0),
      });
      return;
    }
    stats.failed++;
    stats.byProvider[id].failed++;
    log(`✗ ${upstream.label}  ${result.reason}`);
    pushRecent({
      at: new Date().toISOString(),
      ok: false,
      provider: id,
      upstream: upstream.label,
      mode,
      stream,
      status: result.status ?? null,
      overflow: Boolean(result.overflow),
      retryable: Boolean(result.retryable),
      ms: result.ms ?? null,
      reason: String(result.reason || '').slice(0, 300),
    });
    if (result.overflow) {
      // 原样透传：状态码沿用上游的 4xx，正文也尽量保持上游原样，
      // 这样客户端能读到 "maximum context length ... requested N tokens" 并据此触发压缩。
      log(`↳ 上下文溢出，原样透传给客户端（不重试、不兜底）`);
      const raw = result.body ?? '';
      const parsed = safeJsonParse(raw);
      return sendJson(res, result.status || 400, parsed ?? { error: { message: raw.slice(0, 2000), type: 'context_length_exceeded' } });
    }
    if (!result.retryable) {
      return sendJson(res, result.status || 502, { error: { message: result.reason } });
    }
    if (res.headersSent) {
      res.end();
      return;
    }
  }

  sendJson(res, 503, {
    error: { message: '所有上游都失败了，请检查 key / 网络 / 配额' },
    elapsedMs: Date.now() - started,
  });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    log(`✗ 处理 ${req.method} ${req.url} 时异常：${err?.stack || err}`);
    if (res.headersSent) {
      res.end();
      return;
    }
    try {
      sendJson(res, 500, { error: { message: String(err?.message || err) } });
    } catch {
      res.end();
    }
  });
});

server.listen(cfg.port, cfg.host, () => {
  const at = now();
  const p = choose();
  const next = nextSwitch(at);
  console.log('时间路由代理已启动');
  console.log(`  监听      http://${cfg.host}:${cfg.port}/v1`);
  console.log(`  北京时间  ${clock(at)}`);
  console.log(`  当前选择  ${p.provider}  — ${p.reason}`);
  console.log(`  下次切换  ${next.text}`);
  console.log(`  节假日    ${getHolidays().length} 天（holidays.json）`);
  for (const [id, u] of Object.entries(cfg.upstreams)) {
    console.log(`  ${u.label.padEnd(14)} ${u.base}  model=${u.model}  key=${u.key ? '已配置' : '未配置'}`);
  }
  if (!available('deepseek') && !available('ollama')) {
    console.log('\n⚠ 两个 key 都没配置，服务会启动但请求全部返回 500');
  }
  console.log('');
});

server.on('error', (err) => {
  console.error(`启动失败: ${err.message}`);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n正在关闭...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  });
}

// 常驻进程的兜底：单个请求/连接出错不应该让整个代理消失。
process.on('uncaughtException', (err) => {
  log(`未捕获异常（进程继续）：${err?.stack || err}`);
});
process.on('unhandledRejection', (err) => {
  log(`未处理的 Promise 拒绝（进程继续）：${err?.stack || err}`);
});
process.on('exit', (code) => {
  try {
    fs.appendFileSync(
      process.env.ROUTER_LOG_FILE || path.join(HERE, 'router.log'),
      `[${new Date().toISOString()}] 进程退出 code=${code}\n`,
    );
  } catch {
    /* 退出时尽力而为 */
  }
});
