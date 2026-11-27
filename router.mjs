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
  // 读上游错误正文（4xx/5xx 的 JSON）的上限。正常几百字节就结束，等这么久只是兜底：
  // 上游回了响应头却把正文挂住时，不能跟着它一起挂（客户端早就等不及了）。
  errorBodyTimeoutMs: Number(process.env.ROUTER_ERROR_BODY_TIMEOUT_MS || 15000),
  // 上游熔断：同一家连续失败这么多次就先别用它了（=0 关闭）。额度用尽类错误一次即熔断。
  breakerFails: Number(process.env.ROUTER_BREAKER_FAILS ?? 3),
  // 熔断之后每隔这么久用一条 1-token 探针试活，通了立刻恢复（默认 3 分钟）
  breakerProbeMs: Number(process.env.ROUTER_BREAKER_PROBE_MS || 180000),
  breakerProbeTimeoutMs: Number(process.env.ROUTER_BREAKER_PROBE_TIMEOUT_MS || 20000),
  // 多久扫一次「有没有到点的探针」。不用跟探针间隔一样：扫得勤一点，探针就能准时发。
  breakerTickMs: Number(process.env.ROUTER_BREAKER_TICK_MS || 15000),
  bodyLimitBytes: 64 * 1024 * 1024,
  // 余额只是看板上的两张卡，宁可 2 秒拿不到显示「取不到」，也不能让整页跟着卡
  balanceTimeoutMs: Number(process.env.ROUTER_BALANCE_TIMEOUT_MS || 3000),
  balanceTtlMs: Number(process.env.ROUTER_BALANCE_TTL_MS ?? 60000),
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
  // 用户真正发起的请求数（一个请求可能要试两家）
  userRequests: 0,
  // 上游尝试次数：一次用户请求若首选失败再兜底，会记 2 次。
  // 二者必须分开——否则「今天用了 2 次」里有一次只是失败重试，用户会觉得莫名其妙。
  requests: 0,
  ok: 0,
  failed: 0,
  fallbacks: 0,
  // 客户端（DSH 按 Esc / 关窗口）主动断开、把上游请求一起中止的次数
  clientAborted: 0,
  actualCny: 0,
  // 手动测试请求（带 x-router-force 头）单独统计，避免把"省了多少"搅成负数
  probeRequests: 0,
  probeCny: 0,
  byProvider: { deepseek: emptyStats(), ollama: emptyStats() },
  // 每一档实际被请求了多少次：用来证明 DSH 选的那档真的下发到了上游
  byEffort: {},
  last: null,
  lastEffort: null,
  // max_tokens 护栏：DSH 长会话会把 max_tokens 钳成 1（见 applyMaxTokensGuard 注释）
  maxTokensGuard: { hits: 0, last: null },
  // 熔断：opens=暂停过几次，recoveries=探活救回来几次，probeRequests/probeCny=探针的账
  breaker: { opens: 0, recoveries: 0, last: null, probeRequests: 0, probeCny: 0 },
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

// ------------------------------------------------------- max_tokens 护栏
//
// 为什么需要它（2026-11 实测的真实故障）：
//   DSH 走 pi-ai 系适配器（openai-completions）时，replay 出来的历史 assistant 消息
//   usage 一律被清零，于是 pi-ai 的 estimateContextTokens() 永远拿不到真实 usage，
//   退化成「全部字符数 ÷ 3.5」。长会话（本机实测 4,692,754 字符 ≈ 1,340,787 估算 token）
//   一旦超过模型声明的 contextWindow，clampMaxTokensToContext() 算出的 available
//   变成负数，又被 Math.max(1, …) 抬成 1 —— 于是 DSH 真的发出 max_tokens=1。
//   上游老老实实只吐 1 个 token 并回 finish_reason=length，客户端就显示
//   「已达到输出 token 上限」。官方 deepseek 适配器根本不估算也不钳位，所以同一会话
//   切到官方就正常 —— 这就是「换官方能继续、用路由器不行」的真正原因。
//
// 护栏做的事：把「长对话 + 小得不合理」的 max_tokens 抬回一个能用的下限。
//   - 只动 messages >= ROUTER_GUARD_MIN_MSGS（默认 20）的请求：
//     DSH 探活 / 标题 / 摘要这类请求是 1~2 条消息 + 16/32/4096，不能碰。
//   - 只抬 max_tokens < ROUTER_GUARD_MAX_TOKENS（默认 128000 = 128k）的：
//     正常请求本来就发 128000，原样不动。
//     默认 128000 与 DSH 侧 models[].maxTokens 保持一致：被钳坏的请求应当恢复成
//     「本该有的输出预算」，而不是只给一个勉强够写一段的值。历史教训——初版取 8192，
//     实测 124 次抬升里有 4 次正好写满 8192，又撞一次上限，用户看到的现象就是
//     「我明明设了 128k，怎么最大输出变成 8192」。
//     128k 的安全性由真实数据兜底：日志里 14980 次成功请求的真实输入
//     p50=122k / p95=182k / p99=199k / max=229k，229k + 128k = 357k，
//     离 1M 窗口还很远；历史上 29 次超窗 400 报出的真实 prompt 全在
//     111 万~147 万，没有一条落在「128k 会 400 而 8192 不会」的中间带。
//   - 抬上去以后若真实输入真的塞不下，上游会回 400 上下文超长 ——
//     下面的 overflow 分支会原样透传，DSH 据此触发压缩。
//     比「静默吐 1 个 token」好排查得多。
//   - ROUTER_GUARD_MAX_TOKENS=0 可整体关掉。
const GUARD_MAX_TOKENS = Number(process.env.ROUTER_GUARD_MAX_TOKENS ?? 128000);
const GUARD_MIN_MSGS = Number(process.env.ROUTER_GUARD_MIN_MSGS ?? 20);

function applyMaxTokensGuard(body) {
  if (!Number.isFinite(GUARD_MAX_TOKENS) || GUARD_MAX_TOKENS <= 0) return null;
  const msgs = Array.isArray(body?.messages) ? body.messages.length : 0;
  if (msgs < GUARD_MIN_MSGS) return null;
  // 两个字段都要看，不能命中第一个就 return：OpenAI 系上游里 max_completion_tokens 优先级
  // 高于 max_tokens，只改前者等于没改（实测上游会照旧按 max_completion_tokens=1 只吐 1 个 token）。
  // 字符串形式（"1"）也认：有些网关把数字序列化成字符串，typeof !== 'number' 直接跳过同样等于没改。
  const raised = [];
  for (const field of ['max_tokens', 'max_completion_tokens']) {
    const raw = body[field];
    if (raw === undefined || raw === null || raw === '') continue;
    const v = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(v) || v >= GUARD_MAX_TOKENS) continue;
    body[field] = GUARD_MAX_TOKENS;
    raised.push({ field, from: v, stringForm: typeof raw === 'string' });
    log(
      `⚠ ${field}=${raw} 太小而消息有 ${msgs} 条，判定为上下文钳位残留 → 抬到 ${GUARD_MAX_TOKENS}` +
        `（ROUTER_GUARD_MAX_TOKENS 可调，=0 关闭）`,
    );
  }
  if (!raised.length) return null;
  stats.maxTokensGuard.hits++;
  stats.maxTokensGuard.last = {
    at: new Date().toISOString(),
    field: raised.map((r) => r.field).join('+'),
    from: raised[0].from,
    to: GUARD_MAX_TOKENS,
    msgs,
    fields: raised,
  };
  return { field: raised[0].field, from: raised[0].from, to: GUARD_MAX_TOKENS, fields: raised };
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
function record({ provider, tier, dsTier, usage, ms, fallback, effort, probe, first = false }) {
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
    if (first) stats.userRequests++;
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
  if (!probe) addToDay(beijingDateKey(now()), { provider, usage, cost, userRequest: first });
  // 无论上游有没有回 usage，都记下"这一次请求的思考档位"——这是证明档位真的下发的凭据
  stats.lastEffort = { at: new Date().toISOString(), provider, ...effort };
  return { cost };
}

/**
 * 记一次失败进账本。失败没有 usage、没有花费，但必须让 /_router/stats 和
 * stats.json 都能看见——否则看板永远显示"0 失败"，故障率彻底不可见。
 *
 * 计数口径：`requests` 是**上游尝试次数**（成功 + 失败 + 客户端断开），
 * 由 ok / failed / clientAborted 三者拆开，三者相加恒等于 requests。
 * 用户真正发起的请求数另记在 `userRequests`：一次提问若首选失败再兜底成功，
 * requests 会 +2 而 userRequests 只 +1（见 addToDay 的 `userRequest` 参数）。
 */
function recordFailure({ provider, probe, first = false }) {
  if (probe) return;
  stats.requests++;
  stats.failed++;
  if (first) stats.userRequests++;
  const s = stats.byProvider[provider];
  if (s) {
    s.requests++;
    s.failed++;
  }
  addToDay(beijingDateKey(now()), { provider, usage: null, cost: 0, ok: false, userRequest: first });
}

/** 客户端自己走了（不是上游的错），单独记一栏，不算失败 */
function recordClientAbort({ provider, probe, first = false }) {
  if (probe) return;
  stats.requests++;
  stats.clientAborted++;
  if (first) stats.userRequests++;
  const s = stats.byProvider[provider];
  if (s) s.requests++;
  addToDay(beijingDateKey(now()), { provider, usage: null, cost: 0, ok: false, clientAborted: true, userRequest: first });
}

// ------------------------------------------------------------------ 历史账本

// 按北京日期分桶写进 stats.json，重启不清零，看板才能回答"这个月省了多少"
const STATS_FILE = process.env.ROUTER_STATS_FILE || path.join(HERE, 'stats.json');
const history = { days: {} };
const zeroDay = () => ({
  // 用户发起的请求数（一个请求可能产生多次上游尝试）
  userRequests: 0,
  requests: 0,
  ok: 0,
  failed: 0,
  clientAborted: 0,
  prompt: 0,
  cached: 0,
  completion: 0,
  costCny: 0,
  byProvider: {
    deepseek: { requests: 0, failed: 0, prompt: 0, cached: 0, completion: 0, costCny: 0 },
    ollama: { requests: 0, failed: 0, prompt: 0, cached: 0, completion: 0, costCny: 0 },
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
  // version 1 的账本没有 userRequests 字段（2026-11-24 才加）。用文件版本号而不是
  // 「字段看着不对」来判断，回填只做一次：写回 version 2 之后，任何一天都不会再被改。
  const legacy = !(Number(raw?.version) >= 2);
  // 老账本里没有后来新增的字段（failed / clientAborted），而且「字段缺失时 ++ 会得到 NaN，
  // JSON.stringify 又把 NaN 写成 null」—— 线上真出现过 "clientAborted": null。所以这里
  // 不只补默认值，还要把所有计数字段强制归一到有限数字，否则一个 null 会一路传染下去。
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const COUNTERS = ['userRequests', 'requests', 'ok', 'failed', 'clientAborted', 'prompt', 'cached', 'completion', 'costCny'];
  // 分上游的桶不需要 userRequests / ok / clientAborted：这三项只在合计层有意义
  // （一次提问只算一次用户请求，逐家累加会重复）。写进 byProvider 只会留下永远为 0 的脏字段。
  const PROVIDER_COUNTERS = ['requests', 'failed', 'prompt', 'cached', 'completion', 'costCny'];
  let backfilled = 0;
  for (const [k, d] of Object.entries(history.days)) {
    if (!d || typeof d !== 'object') {
      delete history.days[k];
      continue;
    }
    const base = zeroDay();
    const day = { ...base };
    for (const f of COUNTERS) day[f] = num(d[f] ?? base[f]);
    // version 1 的账本没有 userRequests（该字段 2026-11-24 才加），读出来是 0。
    // 填 0 会让看板显示「18 次」而 requests 是 1312——比不显示更误导。
    // 回填取 requests 这个上界：两者只差「首选失败后兜底重试」的次数，历史上是几十的量级，
    // 所以估算误差很小；而且宁可略高也不要抹成 0。只对 legacy 账本做，写回 version 2 后不再重复。
    if (legacy && day.requests > 0 && (d.userRequests === undefined || d.userRequests === null)) {
      day.userRequests = day.requests;
      backfilled++;
    }
    day.byProvider = {};
    for (const id of new Set([...Object.keys(base.byProvider), ...Object.keys(d.byProvider || {})])) {
      const z = base.byProvider[id] || { requests: 0, failed: 0, prompt: 0, cached: 0, completion: 0, costCny: 0 };
      const s = d.byProvider?.[id] || {};
      const merged = {};
      for (const f of PROVIDER_COUNTERS) merged[f] = num(s[f] ?? z[f] ?? 0);
      day.byProvider[id] = merged;
    }
    // 口径自检：requests 必须等于三种结局之和。老账本里曾有过渡版本写歪过（多算几次），
    // 不擅自改历史，但要留一条日志，免得以后拿它当基准算出错误的故障率。
    const split = day.ok + day.failed + day.clientAborted;
    if (day.requests !== split) log(`账本 ${k} 口径不一致：requests=${day.requests} 但 ok+failed+clientAborted=${split}（历史遗留，不改写）`);
    history.days[k] = day;
  }
  if (backfilled) log(`账本 ${backfilled} 天缺 userRequests（该字段 2026-11-24 才加），按 requests 回填`);
  // 回填要落盘，否则下次重启又从头算一遍（scheduleSave 是函数声明，声明位置在这里之后也没关系）
  if (backfilled) scheduleSave();
  // 账本按天分桶，永远只增不减；一年就是 365 个桶，留着够看，再旧的就裁掉
  const keepDays = Number(process.env.ROUTER_STATS_KEEP_DAYS || 365);
  const keys = Object.keys(history.days).sort();
  const drop = keys.slice(0, Math.max(0, keys.length - keepDays));
  for (const k of drop) delete history.days[k];
  if (drop.length) log(`历史账本裁剪：删掉 ${drop.length} 天旧数据（保留 ${keepDays} 天）`);
}

let saveTimer = null;
let dirty = false;

/** 立即落盘（取消去抖）。退出前必须调一次，否则最后 1.5 秒的请求全丢。 */
function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!dirty) return;
  try {
    // version 2：2026-11-24 起账本带 userRequests。升版本号是为了让「缺字段回填」只做一次
    fs.writeFileSync(STATS_FILE, `${JSON.stringify({ version: 2, days: history.days }, null, 2)}\n`);
    dirty = false;
  } catch (err) {
    // 写失败（磁盘满 / 被占用）时不要清脏标记，否则下一次去抖就不会再试了，账目静默丢失
    log(`历史账本写入失败（保留待写状态，下次再试）：${err.message}`);
  }
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushSave();
  }, 1500);
  if (saveTimer.unref) saveTimer.unref();
}

/**
 * 记一次「有结论的请求」进历史账本（成功、失败都算，客户端主动断开单独记）。
 * 以前只有成功分支调用它，于是 stats.json 里 failed 永远是 0 —— 看板看不见故障率。
 */
function addToDay(day, { provider, usage, cost, ok = true, clientAborted = false, userRequest = false }) {
  // 桶可能来自旧版本账本（没有 clientAborted 字段），undefined++ 会得到 NaN、
  // 再被 JSON.stringify 写成 null。所以每次拿桶都先和 zeroDay() 合一次 ——
  // byProvider 必须逐个 provider 深合，浅合会把整块 provider 换成没有新字段的旧对象。
  const prev = history.days[day] || {};
  const d = (history.days[day] = { ...zeroDay(), ...prev, byProvider: {} });
  for (const id of new Set([...Object.keys(zeroDay().byProvider), ...Object.keys(prev.byProvider || {})])) {
    const z = zeroDay().byProvider[id] || { requests: 0, failed: 0, prompt: 0, cached: 0, completion: 0, costCny: 0 };
    d.byProvider[id] = { ...z, ...(prev.byProvider?.[id] || {}) };
  }
  // 旧桶里可能是 null（历史上真写出过 "clientAborted": null），null++ 会变 1 但语义已丢，
  // 统一先归零再累加，账本才不会带着脏值往下滚。
  for (const f of ['userRequests', 'requests', 'ok', 'failed', 'clientAborted', 'prompt', 'cached', 'completion', 'costCny']) {
    if (!Number.isFinite(d[f])) d[f] = 0;
  }
  // userRequest：这一笔是不是「用户新发起的一个请求」的第一跳。兜底那一跳不算，
  // 否则一次提问会被记成两次。
  if (userRequest) d.userRequests++;
  d.requests++;
  if (clientAborted) d.clientAborted++;
  else if (ok) d.ok++;
  else d.failed++;
  d.costCny += cost;
  const p = (d.byProvider[provider] ||= { requests: 0, failed: 0, prompt: 0, cached: 0, completion: 0, costCny: 0 });
  // 老桶可能缺 failed：这里也补一次，免得 p.failed++ 变 NaN
  for (const f of ['requests', 'failed', 'prompt', 'cached', 'completion', 'costCny']) {
    if (!Number.isFinite(p[f])) p[f] = 0;
  }
  p.requests++;
  if (!ok && !clientAborted) p.failed++;
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
    for (const f of ['userRequests', 'requests', 'ok', 'failed', 'clientAborted', 'prompt', 'cached', 'completion', 'costCny']) {
      t[f] += d[f] || 0;
    }
    for (const id of ['deepseek', 'ollama']) {
      const s = (d.byProvider && d.byProvider[id]) || {};
      const o = t.byProvider[id];
      for (const f of ['requests', 'failed', 'prompt', 'cached', 'completion', 'costCny']) o[f] += s[f] || 0;
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
    breaker: { ...stats.breaker, probeCny: Number(stats.breaker.probeCny.toFixed(6)), state: breakerView() },
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

// 主日志一律走 stdout：常驻运行是 supervisor 把 stdout 重定向进 autostart/router-supervisor.log，
// 由它负责轮转。ROUTER_LOG_FILE 只用于「进程退出」那一行（stdout 可能已经没了，
// 退出记录只能直接写文件）。别在这里改成写 ROUTER_LOG_FILE，否则 supervisor 模式下会写两份。
function log(msg) {
  const d = new Date();
  console.log(`[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}] ${msg}`);
}

function available(id) {
  return Boolean(cfg.upstreams[id]?.key);
}

// ------------------------------------------------------------ 上游熔断
//
// 为什么需要：2026-11-27 Ollama 套餐额度用尽后，上游对每条请求都回
//   429 {"error":{"message":"you (…) have reached your monthly usage limit …"}}
// 而路由器只会「先打它一次，失败再兜底」，于是每条用户请求都白等 2~3 秒
// （实测 15:20–16:30 之间 281 次，累计十几分钟），账本里也多出几百条失败。
// 熔断器把「这家现在不能用」记在内存里：选择时直接跳过，然后按固定间隔发探针，
// 探针通了就自动恢复——不需要人去托盘里手动切模式。
//
// 三态（标准 half-open）：
//   closed  正常。连续失败到 ROUTER_BREAKER_FAILS 次 → open
//   open    不再被 choose() 选中；每 ROUTER_BREAKER_PROBE_MS 发一条 1-token 探针
//   探针成功 → closed（失败计数清零，重新按模式/时段选路）；探针失败 → 继续 open
// 额度用尽的错误是确定性的（402，或带 quota/credits 字样的 429），一次就熔断，
// 不必让用户陪着试满 3 次。
//
// 哪些失败算「这家不行」：网络层失败 / 首字节超时 / 5xx / 429 / 401·402·403 / 408·409·425。
// 不算：400·404·422（参数方言问题，换个请求就好）、413、上下文溢出（是请求本身的错）、
// 客户端断开（是我们这边客户走了，与上游无关）。把 400 也算进去会误伤整家：
// 实测「换一家网关参数不被接受」是常态，那属于回退要解决的事，不是上游不健康。
const BREAKER_FAILS = Number(process.env.ROUTER_BREAKER_FAILS ?? 3);
const BREAKER_PROBE_MS = Number(process.env.ROUTER_BREAKER_PROBE_MS || 180000);
const BREAKER_PROBE_TIMEOUT_MS = Number(process.env.ROUTER_BREAKER_PROBE_TIMEOUT_MS || 20000);
const BREAKER_COUNT_STATUS = new Set([401, 402, 403, 408, 409, 425, 429, 500, 501, 502, 503, 504, 505, 529]);
const QUOTA_PATTERNS = [
  /monthly usage limit/i,
  /insufficient (?:balance|quota|credits?|funds)/i,
  /quota (?:exceeded|exhausted|reached)/i,
  /add usage credits/i,
  /payment required/i,
  /credit balance is too low/i,
  /余额不足/,
];

const breaker = Object.fromEntries(
  Object.keys(cfg.upstreams).map((id) => [
    id,
    { open: false, fails: 0, opens: 0, openedAt: 0, nextProbeAt: 0, probing: false, lastReason: '', lastProbe: null },
  ]),
);

function isQuotaExhausted(text) {
  return QUOTA_PATTERNS.some((re) => re.test(String(text || '')));
}

/** 这次失败算不算「上游不健康」（true = 计入熔断） */
function breakerCounts(result) {
  if (!result || result.clientGone) return false;
  if (result.overflow) return false;
  if (typeof result.status === 'number') return BREAKER_COUNT_STATUS.has(result.status);
  return true; // 网络层：连接失败 / 首字节超时 / 流在首字节前断
}

const humanSec = (ms) => {
  const sec = Math.max(1, Math.round(ms / 1000));
  return sec >= 60 ? `${Math.floor(sec / 60)} 分 ${sec % 60} 秒` : `${sec} 秒`;
};

function openBreaker(id, reason, { quota = false } = {}) {
  const b = breaker[id];
  if (!b || b.open) return;
  b.open = true;
  b.opens++;
  b.openedAt = Date.now();
  b.nextProbeAt = Date.now() + BREAKER_PROBE_MS;
  b.lastReason = String(reason || '').slice(0, 200);
  stats.breaker.opens++;
  stats.breaker.last = { at: new Date().toISOString(), provider: id, action: 'open', reason: b.lastReason };
  const how = quota ? '额度用尽' : `连续 ${b.fails} 次失败`;
  log(
    `⛔ ${cfg.upstreams[id].label} ${how} → 暂停使用（${b.lastReason}）；` +
      `${humanSec(BREAKER_PROBE_MS)}后用一条 1-token 探针试活，通了自动恢复`,
  );
}

function markUpstreamFail(id, result, note) {
  const b = breaker[id];
  if (!b || !(BREAKER_FAILS > 0) || b.open) return;
  if (!breakerCounts(result)) return;
  b.fails++;
  b.lastReason = String(note || result?.reason || '').slice(0, 200);
  const quota = typeof result?.status === 'number' && (result.status === 402 || isQuotaExhausted(result?.body ?? result?.reason));
  if (quota) {
    // 额度类不给「再试两次」的机会：余额没了，重试三次只是白等三次
    openBreaker(id, `额度用尽：${b.lastReason}`, { quota: true });
    return;
  }
  if (b.fails >= BREAKER_FAILS) openBreaker(id, b.lastReason);
}

function markUpstreamOk(id) {
  const b = breaker[id];
  if (!b) return;
  const wasOpen = b.open;
  b.fails = 0;
  if (!wasOpen) return;
  const downtime = b.openedAt ? Date.now() - b.openedAt : 0;
  b.open = false;
  b.nextProbeAt = 0;
  b.lastReason = '';
  stats.breaker.recoveries++;
  stats.breaker.last = { at: new Date().toISOString(), provider: id, action: 'recover' };
  log(`✓ ${cfg.upstreams[id].label} 已恢复使用（熔断持续 ${humanSec(downtime)}）`);
}

/**
 * 探活：给熔断中的上游发一条最小的**真实**请求（1 条消息 + max_tokens=1）。
 * 为什么不看余额接口：余额接口能不能通和能不能推理不是一回事——Ollama 额度用尽时
 * /api/balance 照样 200，只有 /chat/completions 回 429。探针花费记在
 * stats.breaker.probeCny 里，不冒充用户请求，也不算进「省了多少」。
 */
async function probeUpstream(id) {
  const u = cfg.upstreams[id];
  const t0 = Date.now();
  const payload = JSON.stringify({ model: u.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false });
  // 先计数：探针不管通没通都发出去了一次（以前只在成功时 ++，看板上会出现「探过了却写 0 次」）
  stats.breaker.probeRequests++;
  try {
    const r = await fetch(`${u.base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${u.key}` },
      body: payload,
      signal: AbortSignal.timeout(BREAKER_PROBE_TIMEOUT_MS),
    });
    const text = await r.text();
    const ms = Date.now() - t0;
    if (!r.ok) return { ok: false, status: r.status, ms, text };
    try {
      const usage = normalizeUsage(JSON.parse(text)?.usage);
      if (usage) {
        const at = now();
        const tier = id === 'deepseek' ? (isDeepSeekPeak(at) ? 'peak' : 'off') : (isOllamaPeak(at) ? 'peak' : 'off');
        stats.breaker.probeCny += costCny(id, tier, usage);
      }
    } catch {
      /* 探针不解析 usage 也无所谓，能 200 就说明通了 */
    }
    return { ok: true, ms, text };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, text: String(err?.message || err) };
  }
}

/** 每 15 秒看一次有没有到点的探针（探针本身有超时，不会堆起来） */
async function breakerTick() {
  for (const id of Object.keys(cfg.upstreams)) {
    const b = breaker[id];
    if (!b.open || b.probing || !available(id) || Date.now() < b.nextProbeAt) continue;
    b.probing = true;
    try {
      const r = await probeUpstream(id);
      b.lastProbe = { at: new Date().toISOString(), ok: r.ok, ms: r.ms, reason: r.ok ? '' : String(r.text || '').slice(0, 200) };
      if (r.ok) {
        markUpstreamOk(id);
      } else {
        b.nextProbeAt = Date.now() + BREAKER_PROBE_MS;
        b.lastReason = `探活仍失败：${b.lastProbe.reason}`;
        log(
          `⏻ ${cfg.upstreams[id].label} 探活仍失败（${r.status ? `HTTP ${r.status} ` : ''}` +
            `${String(r.text || '').slice(0, 80).replace(/\s+/g, ' ')}），${humanSec(BREAKER_PROBE_MS)}后再试`,
        );
      }
    } finally {
      b.probing = false;
    }
  }
}

/** 给 /_router/status 与托盘快照用的熔断视图 */
function breakerView() {
  const out = {};
  for (const id of Object.keys(cfg.upstreams)) {
    const b = breaker[id];
    out[id] = {
      open: b.open,
      fails: b.fails,
      opens: b.opens,
      reason: b.lastReason || null,
      retryInSec: b.open ? Math.max(0, Math.round((b.nextProbeAt - Date.now()) / 1000)) : 0,
      probing: b.probing,
      lastProbe: b.lastProbe,
    };
  }
  return {
    threshold: BREAKER_FAILS,
    probeIntervalSec: Math.round(BREAKER_PROBE_MS / 1000),
    opens: stats.breaker.opens,
    recoveries: stats.breaker.recoveries,
    last: stats.breaker.last,
    upstreams: out,
  };
}

/** 一行中文摘要（看板卡片与日志共用） */
function breakerText() {
  const bad = Object.keys(cfg.upstreams).filter((id) => breaker[id].open);
  if (!bad.length) return { title: '两家都正常', sub: `连续失败 ${BREAKER_FAILS} 次才熔断；熔断后每 ${humanSec(BREAKER_PROBE_MS)}探活一次` };
  const parts = bad.map((id) => {
    const b = breaker[id];
    return `${cfg.upstreams[id].label} 已暂停（${b.fails} 次失败：${b.lastReason.slice(0, 40)}；${b.probing ? '正在探活' : `${humanSec(b.nextProbeAt - Date.now())}后探活`}）`;
  });
  return { title: `${bad.length} 家暂停中`, sub: parts.join('；') };
}

function pickOther(id) {
  return id === 'ollama' ? 'deepseek' : 'ollama';
}

function choose(force) {
  // 熔断中的上游一律不选（除非另一家也没法用，那也只能回头硬试）
  const usable = (id) => available(id) && !breaker[id]?.open;
  if (force && available(force)) {
    if (!usable(force)) {
      const other = pickOther(force);
      if (usable(other)) {
        return {
          provider: other,
          reason: `请求强制指定 ${cfg.upstreams[force].label}，但它正在熔断中，临时改用 ${cfg.upstreams[other].label}`,
          forced: true,
          mode,
          breakerSkip: force,
        };
      }
    }
    return { provider: force, reason: '请求强制指定', forced: true, mode };
  }
  const m = MODES[mode];
  if (m.kind === 'force') {
    if (!usable(m.provider) && usable(pickOther(m.provider))) {
      const other = pickOther(m.provider);
      const why = available(m.provider) ? '正在熔断中' : '未配置 key';
      return { provider: other, reason: `模式：${m.label}，但 ${cfg.upstreams[m.provider].label} ${why}，改用 ${cfg.upstreams[other].label}`, mode, breakerSkip: m.provider };
    }
    if (available(m.provider)) return { provider: m.provider, reason: `模式：${m.label}`, mode };
  }
  const p = pickProvider(now(), { preferIdle: m.kind === 'auto' ? m.preferIdle : 'deepseek' });
  if (!usable(p.provider)) {
    const other = pickOther(p.provider);
    if (usable(other)) {
      const why = available(p.provider) ? '正在熔断中' : '未配置 key';
      return {
        ...p,
        provider: other,
        reason: `${p.reason}，但 ${cfg.upstreams[p.provider].label} ${why}，改用 ${cfg.upstreams[other].label}`,
        mode,
        breakerSkip: p.provider,
      };
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
  // 客户端已经走了（DSH 按 Esc、关窗口）就别再往死 socket 上写：写了没人收，
  // 还可能在 Node 里冒一个 'write after end'。所有错误路径都靠这一处兜底。
  if (res.writableEnded || res.destroyed) return;
  const body = Buffer.from(JSON.stringify(obj, null, 2));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

// ------------------------------------------------------------------ 上游调用

/**
 * 读上游的错误正文，但限时。返回字符串；超时/出错返回已经收到的部分（可能为空）。
 * 不用 upstreamRes.text()：那个没有超时，上游发了响应头就撒手不管时会把请求挂死。
 */
async function readErrorBody(upstreamRes, ms) {
  const reader = upstreamRes.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  // 超时 promise 只建一次。以前放在循环里每轮新建一个，会在同一个 signal 上
  // 挂一堆 listener（MaxListenersExceededWarning 的老毛病换个地方又犯一次）。
  // finally 里 clearTimeout 之后它永远不会 reject，所以也不会有未处理的拒绝。
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`读错误正文超时（${ms}ms）`)), ms);
  });
  try {
    while (size < 64 * 1024) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      chunks.push(Buffer.from(value));
      size += value.length;
    }
  } catch (err) {
    log(`  上游错误正文没读完（${err?.message || err}），按已收到的 ${size} 字节处理`);
  } finally {
    clearTimeout(timer);
    try {
      await reader.cancel();
    } catch {
      /* 已经断了就没什么可取消的 */
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 尝试一个上游。返回 { ok:true } 表示已经把响应（含流）写给客户端；
 * 返回 { ok:false, retryable, reason } 表示还没写任何字节，可以换一家重试。
 */
async function attempt(upstream, payload, res, opts = {}) {
  const ac = new AbortController();
  const t0 = Date.now();
  // 客户端（DSH 里按 Esc、关窗口、网络掉线）一旦走了，上游请求必须跟着取消：否则上游会
  // 继续生成、继续计费，而客户端早就不要这个结果了。res 的 'close' 在正常 end() 之后
  // 也会触发，所以用 writableEnded 把「我们自己写完了」和「客户端跑了」区分开。
  let clientGone = false;
  const onClientClose = () => {
    if (res.writableEnded) return;
    clientGone = true;
    ac.abort(new Error('客户端已断开'));
  };
  res.on('close', onClientClose);
  try {
    return await attemptOnce(upstream, payload, res, { ...opts, ac, t0, isClientGone: () => clientGone });
  } finally {
    res.off('close', onClientClose);
  }
}

/** attempt 的本体：ac / t0 由外层建好传进来，客户端断开监听只挂一次。 */
async function attemptOnce(upstream, payload, res, opts) {
  const { ac, t0, isClientGone } = opts;
  const url = `${upstream.base}/chat/completions`;
  const timer = setTimeout(() => ac.abort(new Error('首字节超时')), cfg.firstByteTimeoutMs);

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
    if (isClientGone()) return { ok: false, clientGone: true, reason: '客户端已断开', ms: Date.now() - t0 };
    return { ok: false, retryable: true, reason: `连接失败: ${err?.message || err}`, ms: Date.now() - t0 };
  }
  clearTimeout(timer); // 已拿到响应头，后续流式不再设整段超时

  if (!upstreamRes.ok) {
    // 这里必须自己限时：上面刚把「首字节」计时器撤了，而 idle 计时器要到流式循环才 arm，
    // 中间是真空。上游完全可能回了 400 响应头、正文写一半就不结束，此时 await text()
    // 会一直挂着——实测客户端要等 9 秒自己 abort，路由器连一条 ✗ 都来不及记。
    // 用专门的上限（ROUTER_ERROR_BODY_TIMEOUT_MS，默认 15s）而不是 idleTimeout：
    // 错误正文正常只有几百字节，没有理由等两分钟才判它读不完。
    const text = await readErrorBody(upstreamRes, cfg.errorBodyTimeoutMs);
    // 读错误正文（429/5xx 的 JSON）期间客户端可能已经走了：这时既不能当上游失败记账，
    // 更不能接着去换另一家——那会再凭空生成一整段没人要的响应。
    if (isClientGone()) {
      return { ok: false, clientGone: true, reason: '客户端已断开（上游返回错误前已中止）', ms: Date.now() - t0 };
    }
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
  // 背压：res.write() 返回 false 表示内核缓冲区满了（客户端读得比上游吐得慢）。
  // 不理会它的话，整段响应会堆在进程内存里，慢客户端 + 长思考就能把路由器顶爆。
  // 等 'drain'，但客户端中途跑掉时 'drain' 永远不会来，所以同时等 'close'。
  // 注意：用 once 而不是 on。res 上的 'close' 监听器上限是 10，一个长时间的大响应
  // 每遇到一次写满就挂两个监听器，累积到 11 个就冒 MaxListenersExceededWarning，
  // 而且退出时清理不干净。这里在 settle 后把两个都摘掉，只留一个共用 promise。
  let drainWait = null;
  const waitDrain = () => {
    if (drainWait) return drainWait;
    drainWait = new Promise((resolve) => {
      const done = () => {
        res.off('drain', done);
        res.off('close', done);
        drainWait = null;
        resolve();
      };
      res.once('drain', done);
      res.once('close', done);
    });
    return drainWait;
  };
  try {
    while (true) {
      armIdle();
      const { done, value } = await reader.read();
      disarmIdle();
      if (done) break;
      markSent();
      // 只留尾部：usage 总在流的最后，没必要缓存整个响应
      tail += decoder.decode(value, { stream: true });
      if (tail.length > 256 * 1024) tail = tail.slice(-256 * 1024);
      if (!res.write(value)) await waitDrain();
    }
  } catch (err) {
    if (isClientGone()) {
      return { ok: false, clientGone: true, reason: '客户端已断开（上游请求已中止）', ms: Date.now() - t0 };
    }
    if (!sent) {
      // 一个字节都没发出去，交给上层换一家
      return { ok: false, retryable: true, reason: `流在首字节前中断: ${err?.message || err}`, ms: Date.now() - t0 };
    }
    log(`  流中断: ${err?.message || err}`);
  } finally {
    disarmIdle();
  }
  if (isClientGone()) {
    return { ok: false, clientGone: true, reason: '客户端已断开（上游请求已中止）', ms: Date.now() - t0 };
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
  if (hit && Date.now() - hit.at < cfg.balanceTtlMs) return hit.value;
  let value;
  try {
    const origin = new URL(u.base).origin;
    // 3 秒：余额只是看板上的一个卡片，不值得让整页等它。以前串行 8+8 秒，
    // 实测两家都卡死时打开看板要 16 秒，而页面还挂着 5 秒自动刷新。
    const r = await fetch(`${origin}${BALANCE_PATHS[id]}`, {
      headers: { authorization: `Bearer ${u.key}` },
      signal: AbortSignal.timeout(cfg.balanceTimeoutMs),
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

// 两家并行拉，别串行：串行时最坏耗时是两家超时之和（实测 8+8=16 秒），
// 而看板每 5 秒自动刷新一次，浏览器会叠一堆挂着的请求。
async function allBalances() {
  const [deepseek, ollama] = await Promise.all([upstreamBalance('deepseek'), upstreamBalance('ollama')]);
  return { deepseek, ollama };
}

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
  // 上游的错误正文、模型名、余额错误串都是外部可控文本，直接拼进 HTML 会被当成标记。
  // 实测上游回 {"message":"<img src=x onerror=...>"} 时看板里 onerror 原样存活。
  // 这里统一转义，凡是往页面里插字符串的地方都过一遍。
  const bt = breakerText();
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const le = v.lastEffort;
  // le.effort / le.thinking / byEffort 的键都直接来自请求体（客户端可控），也要转义：
  // 以前只有错误正文过了 esc()，这条路径漏着。
  const effortView = esc(le ? le.effort || (le.thinking === 'disabled' ? 'off' : '未指定') : '还没有请求');
  const effortSub = le
    ? `thinking=${esc(le.thinking || '未带')} · ${esc(cfg.upstreams[le.provider]?.label ?? le.provider)} · ${new Date(le.at).toLocaleTimeString('zh-CN', { hour12: false })}` +
      `　各档累计：${esc(Object.entries(v.byEffort).map(([k, n]) => `${k}×${n}`).join(' / '))}`
    : '在 DSH 里选一档推理等级，发一句话就能看到';
  const rows = Object.entries(v.byProvider)
    .map(
      ([id, s]) =>
        `<tr><td>${esc(cfg.upstreams[id].label)}</td><td>${s.requests}${s.failed ? ` <span class="warn">失败 ${s.failed}</span>` : ''}</td><td>${s.prompt.toLocaleString()}</td>` +
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
        : { value: '—', sub: esc(JSON.stringify(ds.data).slice(0, 60)) };
    } else {
      dsCard = { value: '取不到', sub: esc(String(ds?.error || `HTTP ${ds?.status}`)) };
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
      olCard = { value: '—', sub: esc(JSON.stringify(ol.data).slice(0, 60)) };
    } else {
      olCard = { value: '取不到', sub: esc(String(ol?.error || `HTTP ${ol?.status}`)) };
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
    // 失败数直接挂在次数后面：以前账本只记成功，看板上根本看不出这家挂过
    const bad = s.failed > 0 ? ` <span class="warn">失败 ${s.failed}</span>` : '';
    return `<td>${s.requests || 0} 次${bad}<br><span class="dim">${tok(tk)} token</span><br>${money(s.costCny || 0)}</td>`;
  };
  const upRows = Object.keys(cfg.upstreams)
    .map((id) => `<tr><td>${esc(cfg.upstreams[id].label)}</td>${periods.map(([, t]) => cellOf(t, id)).join('')}</tr>`)
    .join('');
  const upTotal = `<tr><td>合计</td>${periods
    .map(([, t]) => {
      // 「失败」是真故障（上游挂、超窗），红字留着；「客户端断开」是 DSH 自己按 Esc / 换步 /
      // 重试造成的正常现象（每次都是一条被主动放弃的流），累计上千条挂红字顶在首页太扎眼。
      // 这里降成灰色小字跟在花费后面，逐条明细仍可在下面的「最近请求」里看到橙色 ⊘。
      const bad = t.failed > 0 ? `<br><span class="warn">失败 ${t.failed}</span>` : '';
      const aborted = t.clientAborted > 0
        ? `<span class="dim" title="客户端（DSH）主动取消的请求，上游已随之中止，不是路由器故障"> · 断开 ${t.clientAborted}</span>`
        : '';
      // 首行是「用户问了几次」，不是「打了几次上游」：首选失败兜底成功时，
      // 后者会是前者的两倍，看板上会变成「我问了一句话，怎么显示 2 次」。
      const userN = t.userRequests ?? t.requests;
      const tries = t.requests > userN ? `<br><span class="dim" title="一次提问可能先试失败一家再兜底成功，这里记的是上游尝试次数">上游尝试 ${t.requests} 次</span>` : '';
      return `<td>${userN} 次<br><span class="dim">${tok(t.tokens.input + t.tokens.output)} token</span><br>${money(t.costCny)}${aborted}${bad}${tries}</td>`;
    })
    .join('')}</tr>`;
  // 每家花了多少：只列真正有请求的那几家
  const split = (t) =>
    Object.entries(t.byProvider || {})
      .filter(([, s]) => s?.requests)
      .map(([id, s]) => `${esc(cfg.upstreams[id]?.label ?? id)} ${s.requests} 次 ${money(s.costCny)}`)
      .join(' · ');
  // 最近请求：聚合数字回答不了「刚才那条为什么失败」，这里给个短列表
  const recentRows = recent
    .slice(0, 10)
    .map((e) => {
      const t = e.at ? new Date(e.at) : null;
      const hhmm = t
        ? `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`
        : '';
      const result = e.ok
        ? '<span style="color:#4ade80">✓</span>'
        : e.clientGone
          ? '<span style="color:#fbbf24">⊘ 客户端断开</span>'
          : `<span style="color:#f87171">✗ ${e.status ?? ''}</span>`;
      const tk = (e.prompt ?? 0) + (e.completion ?? 0);
      const detail = e.ok
        ? `${tok(tk)} · ${money(e.costCny || 0)}`
        : `<span class="dim">${esc(String(e.reason || '').slice(0, 70))}</span>`;
      return `<tr><td>${hhmm}</td><td>${esc(e.upstream)}</td><td>${result}</td><td>${e.ms ?? ''}ms</td><td>${detail}</td></tr>`;
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
  .warn{color:#f87171;font-size:12px}
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
  <p class="now">${esc(cfg.upstreams[p.provider].label)}<small>模型 ${esc(cfg.upstreams[p.provider].model)} · ${esc(p.reason)}</small></p>
  <div class="grid">
    <div class="card"><span class="lbl">北京时间</span><b>${clock(at)}</b>
      <span class="sub">下次切换：${next.text}</span>
      <span class="sub">DeepSeek 高峰：工作日 09:00–12:00、14:00–18:00${isDeepSeekPeak(at) ? '（现在就是）' : ''}</span>
      <span class="sub">Ollama 高峰：工作日 20:00–次日 02:00${isOllamaPeak(at) ? '（现在就是）' : ''}</span></div>
    <div class="card"><span class="lbl">推理档位（最近一次请求）</span><b>${effortView}</b>
      <span class="sub">${effortSub}</span></div>
    <div class="card"><span class="lbl">本次运行 · 花费</span><b>${money(v.actualCny)}</b>
      <span class="sub">${v.userRequests} 次请求${v.requests > v.userRequests ? `（上游尝试 ${v.requests} 次）` : ''}${v.probeCny > 0 ? `，另有测试 ${v.probeRequests} 次 ${money(v.probeCny)}` : ''}</span>
      <span class="sub">${split({ byProvider: v.byProvider })}</span></div>
    <div class="card"><span class="lbl">本次运行 · token</span><b>${tok(v.tokens.input + v.tokens.output)}</b>
      <span class="sub">${tokLine(v.tokens)}</span></div>
    <div class="card"><span class="lbl">上游健康（熔断）</span><b>${esc(bt.title)}</b>
      <span class="sub">${esc(bt.sub)}</span>
      <span class="sub">救回 ${v.breaker.recoveries} 次 · 探针 ${v.breaker.probeRequests} 次 ${money(v.breaker.probeCny)}</span></div>
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
      <span class="sub">${h.today.userRequests ?? h.today.requests} 次 · ${tokLine(h.today.tokens)}</span>
      <span class="sub">${split(h.today)}</span></div>
    <div class="card"><span class="lbl">近 7 天</span><b>${money(h.last7.costCny)}</b>
      <span class="sub">${h.last7.userRequests ?? h.last7.requests} 次 · ${tokLine(h.last7.tokens)}</span>
      <span class="sub">${split(h.last7)}</span></div>
    <div class="card"><span class="lbl">累计（含以往运行）</span><b>${money(h.total.costCny)}</b>
      <span class="sub">${h.total.userRequests ?? h.total.requests} 次 · ${tokLine(h.total.tokens)}</span>
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
    `breakerDeepseek=${breaker.deepseek.open ? `open(${breaker.deepseek.fails}次,${Math.max(0, Math.round((breaker.deepseek.nextProbeAt - Date.now()) / 1000))}s后探活)` : `ok(${breaker.deepseek.fails}次连续失败)`}`,
    `breakerOllama=${breaker.ollama.open ? `open(${breaker.ollama.fails}次,${Math.max(0, Math.round((breaker.ollama.nextProbeAt - Date.now()) / 1000))}s后探活)` : `ok(${breaker.ollama.fails}次连续失败)`}`,
    `breakerOpens=${stats.breaker.opens}`,
    `breakerRecoveries=${stats.breaker.recoveries}`,
    `deepseekOk=${dsOk}`,
    `deepseekBalance=${dsText}`,
    `deepseekError=${dsOk ? '' : String(ds?.error || `HTTP ${ds?.status ?? '?'}`)}`,
    `ollamaOk=${inc ? 1 : 0}`,
    `ollamaBalance=${olText}`,
    `ollamaAllowance=${inc ? Number(inc.allowance_usd).toFixed(0) : ''}`,
    `ollamaUntil=${inc?.period?.until ? String(inc.period.until).slice(0, 10) : ''}`,
    // todayRequests 是「用户问了几次」，与看板合计行同口径；兜底重试多打的那一次
    // 记在 todayTries 里（托盘不显示，排查时用）。
    `todayRequests=${h.today.userRequests}`,
    `todayTries=${h.today.requests}`,
    `todayCostCny=${Number(h.today.costCny).toFixed(4)}`,
    `userRequests=${stats.userRequests}`,
    `requests=${stats.requests}`,
    `failed=${stats.failed}`,
    `clientAborted=${stats.clientAborted}`,
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

  // 熔断状态：托盘/脚本排障时想直接看「现在是哪家被暂停、还有多久探活」
  if (url.pathname === '/_router/breaker') {
    return sendJson(res, 200, breakerView());
  }

  // 手动清除熔断（充值后不想等那几分钟探针；或用脚本做测试）
  if (url.pathname === '/_router/breaker/reset') {
    const cleared = [];
    for (const id of Object.keys(breaker)) {
      if (breaker[id].open) cleared.push(id);
      Object.assign(breaker[id], { open: false, fails: 0, nextProbeAt: 0, probing: false, lastReason: '', openedAt: 0 });
    }
    if (cleared.length) log(`熔断状态被手动清除：${cleared.join(', ')}`);
    return sendJson(res, 200, { ok: true, cleared, breaker: breakerView() });
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
      breaker: breakerView(),
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

  // 老版 /v1/completions 传的是 prompt（字符串或字符串数组），不是 messages。
  // 以前原样转发到上游的 /chat/completions，上游收不到 messages 只会报错。
  // 这里就地转成一条 user 消息，让这条路真的能用。
  if (body && !Array.isArray(body.messages)) {
    const p = body.prompt;
    const text = Array.isArray(p) ? p.join('\n') : typeof p === 'string' ? p : null;
    if (text !== null) {
      body = { ...body, messages: [{ role: 'user', content: text }] };
      delete body.prompt;
    }
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
  const guard = applyMaxTokensGuard(body);
  const mtSent = body.max_tokens ?? body.max_completion_tokens;
  log(
    `→ ${first}  ${decision.reason}${stream ? '  [stream]' : ''}${effortTag(effort)}  max_tokens=${mtSent === undefined ? '未发送' : mtSent}` +
      `${guard ? `（原 ${guard.from} 已抬升）` : ''}  msgs=${Array.isArray(body.messages) ? body.messages.length : 0}`,
  );

  for (const [hop, id] of order.entries()) {
    // hop === 0 才是「用户新发起的请求」；后面的是兜底重试，不能重复计进 userRequests
    // 注意别叫 first：外层 first 是「首选 provider」，fallback 判定还在用它
    const isFirst = hop === 0;
    const upstream = cfg.upstreams[id];
    const payload = Buffer.from(
      JSON.stringify({ ...body, model: mapModel(body.model, upstream) }),
    );
    const result = await attempt(upstream, payload, res);
    if (result.clientGone) {
      // 客户端自己走了：不算失败、不换家（它已经收不到任何东西了），只留一条日志
      recordClientAbort({ provider: id, probe: decision.forced === true, first: isFirst });
      log(`⊘ ${upstream.label}  客户端断开，已中止上游（${result.ms}ms）`);
      pushRecent({
        at: new Date().toISOString(),
        ok: false,
        clientGone: true,
        provider: id,
        upstream: upstream.label,
        mode,
        stream,
        ms: result.ms ?? null,
        reason: result.reason,
      });
      if (!res.headersSent) return sendJson(res, 499, { error: { message: '客户端已断开' } });
      if (!res.writableEnded) res.end();
      return;
    }
    if (result.ok) {
      markUpstreamOk(id);
      const usage = normalizeUsage(result.usage);
      const r = record({
        provider: id,
        first: isFirst,
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
        maxTokens: mtSent ?? null,
        maxTokensOriginal: guard?.from ?? null,
        ms: result.ms,
        prompt: usage?.prompt ?? null,
        cached: usage?.cached ?? null,
        completion: usage?.completion ?? null,
        costCny: Number(r?.cost || 0),
      });
      return;
    }
    markUpstreamFail(id, result);
    recordFailure({ provider: id, probe: decision.forced === true, first: isFirst });
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
      // 客户端早跑了就没人收这条错误，别再往一个已销毁的 socket 上写
      if (res.destroyed) return;
      return sendJson(res, result.status || 502, { error: { message: result.reason } });
    }
    if (res.headersSent) {
      res.end();
      return;
    }
    if (res.destroyed) {
      // 客户端在「上一家失败、下一家还没发」的空档断开：别再去打下一家，白烧一次上游调用
      recordClientAbort({ provider: id, probe: decision.forced === true, first: isFirst });
      log('⊘ 客户端已断开，不再重试下一家');
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
  console.log(
    BREAKER_FAILS > 0
      ? `  熔断      连续失败 ${BREAKER_FAILS} 次暂停一家；每 ${humanSec(BREAKER_PROBE_MS)}用 1-token 探针试活（ROUTER_BREAKER_* 可调，FAILS=0 关闭）`
      : '  熔断      已关闭（ROUTER_BREAKER_FAILS=0）',
  );
  for (const [id, u] of Object.entries(cfg.upstreams)) {
    console.log(`  ${u.label.padEnd(14)} ${u.base}  model=${u.model}  key=${u.key ? '已配置' : '未配置'}`);
  }
  if (!available('deepseek') && !available('ollama')) {
    console.log('\n⚠ 两个 key 都没配置，服务会启动但请求全部返回 500');
  }
  console.log('');
});

// 熔断探活：15 秒扫一次，只有到点的才真发探针（探针自带超时，不会堆起来）。
// unref 掉，别让它拖住进程退出。
const breakerTimer = setInterval(() => {
  breakerTick().catch((err) => log(`熔断探活异常：${err?.message || err}`));
}, cfg.breakerTickMs);
if (breakerTimer.unref) breakerTimer.unref();

server.on('error', (err) => {
  console.error(`启动失败: ${err.message}`);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n正在关闭...');
    // 先把还没落盘的账写掉：去抖窗口是 1.5 秒，supervisor 重启 / 手动杀进程
    // 经常正好落在这个窗口里，实测会整条丢掉（统计少一次、少一笔花费）。
    flushSave();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
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
  // 兜底：任何路径退出（含未捕获异常导致的）都要把账本写完
  try {
    flushSave();
  } catch {
    /* 退出时尽力而为 */
  }
  try {
    fs.appendFileSync(
      process.env.ROUTER_LOG_FILE || path.join(HERE, 'router.log'),
      `[${new Date().toISOString()}] 进程退出 code=${code}\n`,
    );
  } catch {
    /* 退出时尽力而为 */
  }
});
