# 变更记录

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
