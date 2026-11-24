# 变更记录

## 2026-11-24 — 体检修掉 9 个问题（错误正文限时 / 护栏双字段 / 看板转义 / 余额并行 / 用户请求数 / 落盘兜底）

### 为什么要体检
用户问「再检查一遍还有没有 bug」。用 15 个真实探针（不是读代码猜）压了一遍：
假上游、真实 abort、慢流、半截错误正文、RST、XSS payload、两家余额同时挂死、
SIGTERM 落盘窗口、MaxListeners、老版 completions 接口。压出 5 个真 bug + 4 个次要问题，全部修掉。

### 逐条

**1. 读上游错误正文没有超时（真 bug，最严重）**
`attemptOnce()` 拿到响应头后立刻 `clearTimeout(timer)` 撤掉首字节计时器，而 idle 计时器要到
流式循环才 arm —— 中间是真空。上游完全可能回了 `400` 响应头、正文写一半就不结束，
此时 `await upstreamRes.text()` 会一直挂着。实测：客户端等了 9011ms 自己 abort，
期间路由器一条 `✗` 都没写。
修：新增 `readErrorBody(upstreamRes, ms)`，用 `Promise.race` 加超时读完即取消，
上限走新的 `ROUTER_ERROR_BODY_TIMEOUT_MS`（默认 15s；错误正文正常只有几百字节，
没有理由跟 `ROUTER_IDLE_TIMEOUT_MS` 的 120s 一起等），超时按已收到的部分处理并记一行日志。

**2. `applyMaxTokensGuard` 命中第一个字段就 return（真 bug）**
原写法 `for (const field of ['max_tokens','max_completion_tokens'])` 里第一次命中就
`return`。OpenAI 系上游里 `max_completion_tokens` 优先级高于 `max_tokens`，
所以同时发 `{max_tokens:1, max_completion_tokens:1}` 时只改了前者，上游照旧只吐 1 个 token。
另外 `max_tokens:"1"`（字符串）因 `typeof v !== 'number'` 被 `continue`，原样透传。
修：两个字段都过一遍，字符串形式用 `Number(raw)` 认；`stats.maxTokensGuard.last.fields`
记下这次到底改了哪几个。回归用例验 `"1"` 会被抬、`"256000"` 不误抬。

**3. 看板把上游文本直拼进 HTML（真 bug，XSS）**
`recent` 行把 `e.reason` 用 `String(...).slice(0,70)` 直接插进 HTML；同病还有 `cellOf`、
`e.upstream`、余额卡的 `sub`、`p.reason`。实测上游回
`{"error":{"message":"<img src=x onerror=\"document.title=1\">"}}` 时 `onerror` 在看板里原样存活。
修：`dashboardHtml()` 里加 `esc()`（`& < > " '` 五个字符），所有插值点统一过一遍。

**4. 两家余额串行拉，看板被拖死（真 bug）**
`allBalances` 原本 `{deepseek: await ..., ollama: await ...}`，每家 `AbortSignal.timeout(8000)`
→ 两家都挂死时最坏 16 秒；而看板页面挂着 `<meta http-equiv="refresh" content="5">`，
浏览器会一直叠挂着的请求。
修：`Promise.all` 并行；单家超时降到 3 秒（新增 `ROUTER_BALANCE_TIMEOUT_MS`），
缓存时间提取成 `ROUTER_BALANCE_TTL_MS`（默认 60000）。回归用例：两家都挂死时 `GET /` < 3.5s。

**5. `requests` 记的是上游尝试次数，不是用户请求数（语义 bug）**
一次提问首选失败 + 兜底成功 → `requests=2 ok=1 failed=1 fallbacks=1`，看板显示
「2 次 / 失败 1」。口径自检 `requests=ok+failed+clientAborted` 仍为 true（内部自洽），
但用户看到的是「我就问了一句，怎么算了两次」。
修：新增并行的 `userRequests` 维度（只数用户真正发起的请求，兜底那跳不算），
`record()` / `recordFailure()` / `recordClientAbort()` 都接受 `first`；
`addToDay()` / `zeroDay()` / `sumDays()` / `loadHistory()` 的 COUNTERS 全带上它；
看板合计行的首行改显示 `userRequests`，两者不同时才补一行灰字「上游尝试 N 次」。
`test-local.mjs` 断言：一次兜底成功 → `requests +2`、`userRequests +1`。

**6. `waitDrain()` 泄漏 `close` 监听器（次要）**
每遇写满就挂一对新监听器，大响应累积 11+ 会冒 `MaxListenersExceededWarning`。
修：共用一个 `drainWait` promise，settle 后把两个监听器都摘掉。

**7. `/v1/completions` 被当 chat 转发（次要）**
老版接口 body 是 `prompt`（字符串或字符串数组），原样转发到上游 `/chat/completions`
上游收不到 `messages` 只会报错。修：就地转成一条 user 消息，删掉 `prompt`。

**8. 退出时丢最后一笔账（次要）**
落盘有 1500ms 去抖，`SIGTERM` 正好落进窗口就整条丢。修：提取 `flushSave()`，
`SIGINT`/`SIGTERM` handler 与 `process.on('exit')` 都刷一次；去抖定时器加 `.unref()`。
回归用例在 Windows 上有坑：`child.kill('SIGTERM')` 是 `TerminateProcess`，handler 根本不跑，
所以新增 `tools/test-sigterm-wrapper.mjs`，在进程内 `process.emit('SIGTERM')` 走同一条分支。

**9. `ROUTER_LOG_FILE` 语义误导（次要）**
文档写成「日志路径」，实际常驻运行时 `log()` 只往 stdout 写（supervisor 重定向进
`autostart/router-supervisor.log`），`ROUTER_LOG_FILE` 只用于「进程退出」那一行。
修：代码注释和 README 都说清，不再让人以为改它就能换日志位置。

### 测试
`node test-local.mjs` **23 → 35 项，35/35 通过**。新增覆盖：错误正文不结束不挂死（< 20s）、
XSS 转义、余额并行（两家都挂死 < 3.5s）、`userRequests` 口径与落盘、SIGTERM 刷盘、
`waitDrain` 不泄漏、老版 completions 转 messages、护栏双字段与字符串形式。
`node schedule.mjs --test` 13/13 + 节假日；`node tools/test-log-rotate.mjs` 6/6。

### 顺手
`.env.example` 补 `ROUTER_ERROR_BODY_TIMEOUT_MS` / `ROUTER_BALANCE_TIMEOUT_MS` / `ROUTER_BALANCE_TTL_MS`，
变量总数 27 → **30**（router 23 + 守护 9，去重后 30）；README 文件表补
`tools/test-sigterm-wrapper.mjs`。

## 2026-11-24 — 看板：客户端断开降级显示，不再顶红字

### 为什么改
看板合计行的「失败 48 · 客户端断开 1344」一进首页就跳出来（红字），用户以为路由器坏了。
查账本 + 全量日志 + DSH 会话存档后确认：这 1344 条是 DSH 自己主动取消的请求，
不是路由器故障，占比 12% 但性质完全正常 —— 挂在首页红字里属于「报忧不报喜」的显示错误。

实测证据：
- 被中止请求的上游耗时 p50=4.9s，成功请求 p50=5.1s —— 分布几乎重合，不是「刚发就撤」。
- 1335/1338 条 `⊘` 后 3 行内紧跟一次新转发；其中 667 条（49.7%）是 `msgs+2`，
  距下一条 p50=8s —— 说明上一步内容其实已落盘，DSH 正常进入下一步。
- DSH 存档 `session-a85bcbc9`（55 轮 / 1393 步）、`session-e64b2659`（17 轮 / 1181 步）
  的 **step 级 aborted 全是 0**；轮级 aborted 仅 3 次（用户真的按了 Esc）。
- 三个探针：读到 `[DONE]` 再断 → 记成功；读到 `finish_reason` 就断 → 记成功；
  只有真的半路掐断才记 clientAborted。所以它不是统计噪声。
- 失败 48 条只占累计 21,463 次的 0.22%，构成：超窗 400 共 35 行、首字节超时 13 行、
  网络 42 行（日志 90 行 ≠ 48 次，一次请求换两家会留两行）；且 `failed` 字段本身就是
  11-22 才加的，之前的老数据必然是 0。

### 改动
- `router.mjs` 合计行：真故障「失败 N」保留红字；「客户端断开 N」降成灰色小字、缩写成
  「断开 N」，跟在花费后面，并带 `title` 悬停说明（"客户端（DSH）主动取消的请求，
  上游已随之中止，不是路由器故障"）。逐条明细仍在下方「最近请求」里显示橙色 ⊘。
- `test-local.mjs`：新增断言「看板合计行把客户端断开降成灰字」（读 `/_router` 的 HTML，
  确认含「断开 N」且不含「客户端断开 N」、红字 span 里不含「断开」）。测试数 **22 → 23**。
- `test-local.mjs` 假上游加固：看板渲染时会去拉两家余额（GET、无 body），原来
  `JSON.parse('')` 会把测试进程直接炸掉。现在非 `*/chat/completions` 一律回 404，
  body 解析失败回 400 而不是抛。
- `README.md`：看板一节补上「失败红字 / 断开灰字」的区别与理由。

## 2026-11-24 — max_tokens 护栏下限 8192 → 128000（128k）

### 为什么改
2026-11-22 的初版护栏把「被 DSH 钳成 1 的输出预算」抬回 8192。用户反馈：明明配了 128k，
长会话里最大输出却变成 8192 —— 因为护栏抬到 8192 之后，模型真的按 8192 生成了，写满就被
上游回 `finish_reason=length`，客户端照样显示「已达到输出 token 上限」。

实测数据（`autostart/router-supervisor.log` 全量）：
- 124 次护栏抬升中，**4 次输出正好写满 8192**（3%），平均输出 1828 token。
- 被抬升那批请求的真实输入只有 77k~93k，占 1M 窗口的 7~9% —— 远没到需要省预算的地步。
- 成功请求的真实输入分布：p50=122k / p95=182k / p99=199k / max=229k。
- 历史 29 次「上下文超窗」400 报出的真实 prompt 全在 111 万~147 万，**没有一条**落在
  「128k 会 400 而 8192 不会」的中间带。229k + 128k = 357k，离 1M 还很远。

### 改动
- `router.mjs`：`GUARD_MAX_TOKENS` 默认值 `8192` → **`128000`**，注释重写为「恢复本该有的
  输出预算」并附上上述实测数据。判断条件 `max_tokens < 128000` 不变，只动被钳坏的值。
  这个值与 DSH 侧 `models[].maxTokens` 保持一致（同一个数，正常请求与被抬升后的请求
  拿到同样的输出预算）。
- `test-local.mjs`：断言从 8192 改成 128000，并新增一条边界用例「刚好等于 128000 时不抬」。
  测试数 **21 → 22**，`node test-local.mjs` 22/22 通过。
- `tools/verify-guard.mjs`：期望值改为常量 `GUARD_TO`（读 `ROUTER_GUARD_MAX_TOKENS`，默认 128000），
  不再写死 8192。
- `.env.example` / `UPDATE-other-pc.md` / `INSTALL-other-pc.md` / `README.md`：同步新默认值与理由，
  示例配置里的 `maxTokens` 也统一成 128000。
- `tools/test-log-rotate.mjs`：修掉一条时间相关的假红断言 —— 原来写死「日志里必须出现
  `→ deepseek`」，但北京时间落进 DeepSeek 高峰时会自动走 Ollama，这条必然失败。改成
  `/→ (deepseek|ollama)/`。

### 影响
- 正常请求（DSH 下发 128000）完全不受影响，仍然原样透传。
- 只有「长对话 + `max_tokens` 小得不合理」的请求会被抬到 128000，用户不再看到 8192 这种
  莫名其妙的截断。
- 若某天真遇到接近 1M 的上下文，护栏会把它顶成上游 400 而不是静默吐 1 个 token ——
  DSH 能识别 400 并触发压缩，比静默截断好排查。`ROUTER_GUARD_MAX_TOKENS=0` 仍可整体关闭。
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
  且 `max_tokens` < `ROUTER_GUARD_MAX_TOKENS`（默认 **128000**，见上方 2026-11-24 条目）** 时，
  把预算抬回 128000 并打警告日志。
  - 只碰长对话：DSH 探活 / 标题 / 摘要那些 1~2 条消息 + 16/32/4096 的请求原样放过。
  - 正常预算（128000 / 256000）一律不动。
  - 抬上去后若真实输入确实塞不下，上游回 400 上下文超长，走已有的 overflow 原样透传分支，
    客户端能据此压缩 —— 比「静默只吐 1 个 token」好排查。
  - `ROUTER_GUARD_MAX_TOKENS=0` 关闭护栏。
- 统计新增 `maxTokensGuard: { hits, last }`，`/_router/stats` 可查；`/_router/recent` 每条
  增加 `maxTokens` / `maxTokensOriginal`。日志行形如 `max_tokens=128000（原 1 已抬升）  msgs=101`。
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
