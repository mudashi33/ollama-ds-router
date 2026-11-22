# 另一台电脑：把已装的 ollama-ds-router 更新到最新版

> 已经装好了，只是要升级。**不要重新 clone、不要重装、不要删 .env / stats.json。**

把下面 **整段** 复制给那台电脑上的 AI（Claude / Codex / DSH 都行）：

```text
这台电脑上已经装过 ollama-ds-router（本地时间路由代理，接在 DeepSeek Harness 当模型上游，
装在 F:\CodeProjects\DeepseekHarnessProjects\ollama-ds-router）。现在要把它增量更新到最新版，
不要重装、不要重新 clone、不要删 .env 和 stats.json。

仓库：https://github.com/mudashi33/ollama-ds-router （公开，不需要登录）

硬性要求：
1. 每一步都实际执行并把命令和输出贴给我，不要只说"应该可以"；报错贴原文再排查，不许跳过。
2. 不要 npm install / pnpm install —— 项目零运行时依赖。
3. 不要打开、打印、复制 .env；只允许用不显示值的方式判断某个变量是否为空。
4. 改 DSH 配置前先备份：cordis.patch.yml 复制成 cordis.patch.yml.bak-<今天日期>。
5. 不要动 stats.json / mode.json / *.log（旧账本缺新字段，代码会自己补齐，不用手工迁移）。

步骤（按顺序，每步验证后再进下一步）：

1) 拉代码
   cd /d F:\CodeProjects\DeepseekHarnessProjects\ollama-ds-router
   git status              → 工作树应该干净；如果有本地改动，先告诉我改了什么再决定
   git log --oneline -1    → 记下更新前的提交号
   git pull
   直连 GitHub 超时或被 reset 就用代理重试（端口按这台机器实际的代理软件，Clash 常见 7897）：
   git -c http.proxy=http://127.0.0.1:7897 -c http.version=HTTP/1.1 pull
   验证：git log --oneline -3 里能看到「稳定性三修」那条提交（2932bad，或其后的文档提交）；
        git rev-parse HEAD 和 git rev-parse origin/main 一致。

2) 自检（三条全绿才能继续）
   node schedule.mjs --test       → 期望 13/13 PASS
   node test-local.mjs            → 期望 21/21 PASS（旧版是 11/11，现在是 21/21）
   node tools/test-log-rotate.mjs → 期望 6/6 PASS（这个文件是新增的）
   任何一条失败：把完整报错贴给我，不要继续，也不要自己改测试。

3) 重启路由器让新代码生效
   先看守护进程在不在：
   Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select ProcessId,CommandLine
   - 有 tools\supervisor.mjs 在跑：只杀掉监听 8788 的那个 node（不是 supervisor），
     守护进程约 1.5 秒会自动用新代码重拉：
     for /f "tokens=5" %p in ('netstat -ano -p tcp ^| findstr LISTENING ^| findstr :8788') do taskkill /PID %p /F
     （写成 .cmd 文件的话把 %p 全改成 %%p；PowerShell 里用 Get-NetTCPConnection -LocalPort 8788 更省事）
     然后等 5 秒。
   - 没有 supervisor：直接跑仓库里的 restart.cmd。
   验证：
   curl http://127.0.0.1:8788/_router/status   → HTTP 200
   curl http://127.0.0.1:8788/_router/stats    → 能看到 clientAborted 字段（新字段，没有说明还是老代码）
   重启瞬间在途请求会断一次，这是正常的。

4) 更新 DSH 里的模型参数（旧配置有两个隐患）
   先备份（<日期> 换成今天，例如 20261122）：
   copy "%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml" "%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml.bak-<日期>"
   在 providers.time-router.models[0] 这一块里两处：
   a) maxTokens: 256000  →  改成 150000
      （按窗口开满会导致「上下文双超限」400；本机实测现在下发 128000）
   b) reasoningEfforts 必须四档齐全，缺 low 会让 /effort 菜单少一项：
      off: null
      low: low
      high: high
      max: max
   改完用 profile 的 node_modules/yaml 解析一次，确认能解析、条目数没变（多一个都不行）。
   如果这两个值本来就是对的，明确告诉我"无需修改"。

5) 完全退出并重启 DSH（桌面版要杀掉所有 DeepSeek Harness 进程，不是关窗口）
   重启后切到「时间路由 (DS/Ollama)」→ auto 发一句话，验证：
   curl http://127.0.0.1:8788/_router/stats  → 请求数 +1、成功数 +1
   curl http://127.0.0.1:8788/_router/recent → 最新一条 ok:true，带 provider / ms / prompt

6) 可选：补 .env 里的新变量（不补也能跑，都有默认值）
   把 .env 里已有的键名和 .env.example 对比，缺的只有下面三个，按需追加：
   ROUTER_GUARD_MAX_TOKENS=8192      # max_tokens 被 DSH 钳成 1 时抬到多少；=0 关闭
   ROUTER_GUARD_MIN_MSGS=20          # 少于这么多条消息不启用护栏
   ROUTER_LOG_MAX_AGE_DAYS=7         # 守护日志超过几天就轮转
   注意：改完 .env 要重做第 3 步的重启才生效。不要打印任何 key 的值。

交付报告请包含：
- 更新前后的 git 提交号（git log --oneline -1 各一次）
- 三条测试的末尾 PASS 计数
- /_router/status 的实际 HTTP 码、/_router/stats 里有没有 clientAborted
- cordis.patch.yml 改了哪几行（只贴改动行）+ 备份文件名
- DSH 重启后 /_router/stats 的数字变化
- 任何一步失败：命令、原文报错、你怎么处理的

不要顺便装别的 DSH 插件，也不要重装路由器；这次只是把已装好的这份更新到最新版。
```

## 这次更新带来了什么（可以只看表，不用贴给 AI）

| 变化 | 对使用的影响 |
|---|---|
| max_tokens 护栏 | DSH 长会话把 `max_tokens` 钳成 1 时，路由器自动抬到 8192，不再出现「已达到输出 token 上限」 |
| 客户端断开即中止上游 | 按 Esc 取消后上游立刻停，不再继续生成计费；这类请求记成「客户端断开」，不算失败 |
| 失败进账本 | 看板/账本里的失败数不再永远是 0；口径固定为 `requests = ok + failed + clientAborted` |
| 日志轮转 | 守护日志超过 5MB 或 7 天自动轮转（copytruncate，不再出现写满磁盘的老问题） |
| 测试 11 项 → 21 项 | 自检更严；新增 `tools/test-log-rotate.mjs` |

## 更新前自己确认一件事

- 那台机器上的 `cordis.patch.yml` 里 `maxTokens` 如果还是 `256000`，第 4 步会把它改成 `150000`——
  这是为了避免「上下文双超限」的 400 错误，不是可选项。
- `.env` 不用动：新变量都有默认值，第 6 步是可选优化。
- 重启路由器时在途请求会断一次（约 1.5 秒），不用紧张。

## 为什么是 git pull 而不是重新装

仓库公开、单分支 main，历史线性（无合并），`git pull` 就是快进到最新。本机的
`.env` / `stats.json` / `mode.json` / `*.log` 都不在版本控制里，拉代码不会碰它们。
