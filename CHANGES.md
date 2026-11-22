# 变更记录

## 2026-11-22 — 稳定性三修（客户端断开 / 失败入账 / 日志轮转）

### 1. 客户端断开不再「空转上游」
以前流式循环只处理「上游断了」，完全不看客户端还在不在。DSH 里按 Esc 取消后，
代理照样把上游的整段流收完 —— 上游继续生成、继续计费。实测：客户端 1.6s abort，
代理跑到 3.9s 才写 `✓ Ollama Cloud 3926ms`。

- `attempt()` 拆成 `attempt()` + `attemptOnce()`：外层建 `AbortController` 并挂
  `res.on('close')`，用 `res.writableEnded` 区分「我们自己写完了」和「客户端跑了」；
  客户端跑了就 `ac.abort()`，fetch 随之取消。
- 流式循环加背压：`res.write()` 返回 false 时等 `drain`（同时监听 `close`，否则客户端跑了
  就永远等不到 drain）。慢客户端 + 长思考时，整段响应不会再堆在进程内存里。
- 这类请求走新的 `recordClientAbort()`：`stats.clientAborted++`，**不算失败**、不换家，
  日志写 `⊘ … 客户端断开，已中止上游（Nms）`，`/_router/recent` 里标 `clientGone: true`。
- 补掉三个边角：①读上游错误正文（429/5xx 的 JSON）期间客户端跑了，也按断开处理，
  不误记成上游失败；②「上一家失败、下一家还没发」的空档里客户端跑了，直接放弃重试，
  不再白烧一次上游调用；③`sendJson()` 开头判 `res.writableEnded || res.destroyed`，
  客户端已走时任何错误响应都不往死 socket 上写（否则 Node 会冒 write after end）。

### 2. 失败终于进账本
`addToDay()` 以前只在 `record()`（成功分支）里调用，`stats.failed++` 只进内存 ——
于是 `stats.json` 里 11985 次请求 11985 次 ok、**0 次 failed**，而同一时段日志里有 42 条 `✗`。
现在失败走 `recordFailure()`：同样按天分桶、按上游分桶，看板「按上游」表在次数后挂红字
「失败 N」，合计行标「失败 N · 客户端断开 N」。带 `x-router-force` 的探针仍只算 `probeCny`。

顺带修掉一个只有上线后才暴露的坑：老账本的桶里没有 `failed` / `clientAborted` 字段，
`undefined++` 得到 `NaN`，`JSON.stringify` 再把它写成 **`null`**（线上真出现过
`"clientAborted": null`，而且会一路传染下去）。现在 `loadHistory()` 读盘时按 `zeroDay()`
做深合并、把所有计数字段强制归一成有限数字，`addToDay()` 取桶时也再归一一次。

### 3. 日志真的会轮转了
`tools/supervisor.mjs` 的 `rotateIfNeeded()` 原来只在**启动子进程**时调用一次，
而且用 `renameSync` 换文件 —— 子进程的 stdout 句柄还指着改名后的那份，
结果 `.1` 越写越大、新文件一直空的。

- 改成 **copytruncate**：`copyFileSync` 到 `.1` 再 `truncateSync(LOG, 0)`，打开着的句柄不受影响。
- 挂到健康检查的 `setInterval` 上（默认每 30s 一次），不再依赖「重启一次才轮转」。
- 新增 `ROUTER_LOG_MAX_AGE_DAYS`（默认 7）：低频运行时只看大小会几个月都轮不到。

### 4. 计数口径统一
`stats.requests` 以前只在成功分支 ++，而 `stats.json` 的按天桶是「成功 + 失败 + 断开」都算一次，
于是看板上出现过「今日 12 次」而「本次运行 9 次」这种对不上的情况。现在 `recordFailure()` /
`recordClientAbort()` 也各自 `requests++`，口径固定为 **`requests = ok + failed + clientAborted`**，
并有测试断言守着。

### 测试与文档
- `test-local.mjs`：**15 → 21 项**。新增客户端 abort 传播（假上游 `/_slow` 慢流 +
  `/_slowstate` 观察是否被掐断）、`clientAborted` 计数与落盘、失败入账与落盘、
  以及 `requests = ok + failed + clientAborted` 的口径断言。
- 测试的账本/模式/日志改为写到 `mkdtemp` 临时目录（以前直接跑在仓库里，
  把测试流量混进真实 `stats.json` 和 `mode.json`，线上账本里那些「测试 2 次」就是它）。
- `.env.example` 补齐全部 27 个变量（原来只列 4 个）；README 补三节说明，
  并修正两处 `maxTokens: 384000`（那是「上下文双超限」400 的来源）与 `reasoningEfforts` 缺 `low` 的漂移。
## 2026-11-22 — max_tokens 护栏（修「已达到输出 token 上限」）

### 问题
DSH 走 time-router（pi-ai / openai-completions 适配器）时，长会话会突然报
「已达到输出 token 上限」，同一会话切回官方 deepseek-official 又一切正常。

### 根因（用 app.asar 源码 + 会话存档 + 线上日志三方对齐）
1. `dsh-llm-pi-ai/src/replay.ts` 重建历史 assistant 消息时把 `usage` 全部清零
   （`emptyPiUsage()`，时间戳也固定成 0）。
2. pi-ai 的 `estimateContextTokens()`（`utils/estimate.js`）因此永远拿不到真实 usage，
   `getLastAssistantUsageInfo()` 恒返回 undefined，只能退化成「全部字符数 ÷ 3.5」。
   退化估值实测约为真实值的 **1.49 倍**。
3. 长会话表面积涨到 4,692,754 字符 ≈ 1,340,787 估算 token，超过模型声明的
   `contextWindow` 后，`clampMaxTokensToContext()`（`api/simple-options.js`）里
   `available = contextWindow - 估算 - 4096` 变负，被 `Math.max(1, ...)` 抬成 **1**。
4. 上游只吐 1 个 token 并回 `finish_reason=length`，DSH 就显示「已达到输出 token 上限」。
   billion-context 的压缩把字符数压回去后又会自己好，所以表现为「时好时坏」。
5. 官方适配器（`dsh-llm-deepseek`，anthropic-messages）**不做估算也不钳位**
   （`serialize.ts` 直接 `max_tokens: options.maxTokens ?? ...`），窗口同为 1,048,576，
   所以同一会话官方永远正常。

### 改动
- `router.mjs` 新增 `applyMaxTokensGuard()`：转发前检查，**消息数 ≥ `ROUTER_GUARD_MIN_MSGS`（默认 20）
  且 `max_tokens` < `ROUTER_GUARD_MAX_TOKENS`（默认 8192）** 时，把预算抬回 8192 并打警告日志。
  - 只碰长对话：DSH 探活 / 标题 / 摘要那些 1~2 条消息 + 16/32/4096 的请求原样放过。
  - 正常预算（128000 / 256000）一律不动。
  - 抬上去后若真实输入确实塞不下，上游回 400 上下文超长，走已有的 overflow 原样透传分支，
    客户端能据此压缩 —— 比「静默只吐 1 个 token」好排查。
  - `ROUTER_GUARD_MAX_TOKENS=0` 关闭护栏。
- 统计新增 `maxTokensGuard: { hits, last }`，`/_router/stats` 可查；`/_router/recent` 每条
  增加 `maxTokens` / `maxTokensOriginal`。日志行形如 `max_tokens=8192（原 1 已抬升）  msgs=101`。
- `test-local.mjs` 假上游回显 `served_max_tokens`；新增 4 条断言（长对话抬升 / 短对话不动 /
  正常预算不动 / 计数可观测），并把「用量与成本统计」改成按两家合计断言
  （原来写死 `byProvider.deepseek`，在 auto-ollama 模式下会无故变红）。测试数 **11 → 15**。
## 2026-11-10 — 守护进程、看板最近请求、超时与托盘增强

### 运行稳定性
- 新增 `tools/supervisor.mjs`：真正意义上的守护进程。
  - 单实例靠绑定控制端口 8790（`ROUTER_SUPERVISOR_PORT`）判断，第二个实例发现回包含
    `router-supervisor` 就退出，避免双开抢 8788。
  - 子进程 `node --env-file=.env router.mjs` 退出后 5 秒重拉（`ROUTER_RESTART_MS`）。
  - 每 30 秒打 `/_router/status`，连续 3 次失败就杀掉子进程强制重启。
  - 日志超过 5MB（`ROUTER_LOG_MAX_BYTES`）自动改名为 `.1` 后重开，写 `autostart/router-supervisor.log`。
  - 8788 被别的进程占用时不抢，每 30 秒探一次，释放后接管。
- 计划任务 **Ollama-DS-Router** 改为：登录触发 + 每 1 分钟重复（`PT1M / P3650D`）做自愈；
  动作仍是 `wscript autostart\router-hidden.vbs`，由它静默拉起守护。
- `autostart\router-hidden.vbs` 重写：命令行改用 `Chr(34)` 拼接。
  旧版一行里引号数量不配对（`""" """` 那一段），wscript 直接报「未结束的字符串常量」，
  任务表面上 Running 但守护从来没起来过。

### 超时
- 首字节超时 180s → **60s**（`ROUTER_FIRST_BYTE_TIMEOUT_MS`）。
- 新增流空闲超时 **120s**（`ROUTER_IDLE_TIMEOUT_MS`）：上游 200 之后迟迟不吐新数据就断开换家，
  不再干等。

### 可观测性
- 新增 `GET /_router/recent`：内存环形缓冲最近 20 条（`ROUTER_RECENT_MAX`），
  成功记上游/耗时/缓存命中/花费，失败记状态码/是否上下文溢出/原因。
- 看板新增「最近请求」表格（最近 10 条）。
- `stats.json` 启动时按 `ROUTER_STATS_KEEP_DAYS`（默认 365）裁掉旧日期桶。

### 托盘小工具（`tray/RouterTray.exe`，重新编译）
- 右键菜单新增 **打开看板（浏览器）** 与 **复制状态到剪贴板**
  （模式 / 生效上游 / 下次切换 / 两家余额 / 今天次数与花费）。
- 余额低时图标变**黄**并气泡提醒一次：DeepSeek < ¥5 或 Ollama < $5；
  余额回上去后再低会重新提醒（`LOW_BALANCE_DS` / `LOW_BALANCE_OL` 两个常量）。
- 图标颜色语义：蓝 = 官方，绿 = Ollama，灰 = 连不上，黄 = 余额偏低。

### 未改
- DSH 侧 `contextWindow 1048576` / `maxTokens 256000` **按用户要求保持原样**。
