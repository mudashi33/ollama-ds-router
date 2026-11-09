# DeepSeek ⇄ Ollama 时间路由

按北京时间把请求自动发给当前更便宜的那一家，同一套模型（DeepSeek V4.1-Flash）。

> 换一台电脑装？见 [INSTALL-other-pc.md](INSTALL-other-pc.md)（整段复制给那边的 AI 执行即可）。

## 为什么能省

两家价格几乎一样（同档位差约 6%），但**高峰时段正好错开**：

| 北京时间（工作日） | DeepSeek 官方 | Ollama Cloud | 用谁 |
|---|---|---|---|
| 00:00–02:00 | 空闲 | 高峰 | DeepSeek |
| 02:00–09:00 | 空闲 | 空闲 | DeepSeek |
| **09:00–12:00** | **高峰** | 空闲 | **Ollama** |
| 12:00–14:00 | 空闲 | 空闲 | DeepSeek |
| **14:00–18:00** | **高峰** | 空闲 | **Ollama** |
| 18:00–20:00 | 空闲 | 空闲 | DeepSeek |
| 20:00–24:00 | 空闲 | 高峰 | DeepSeek |

周末与法定节假日两家都空闲 → 全用 DeepSeek。

所以规则只有一句：**工作日 9–12、14–18 点用 Ollama，其余时间用 DeepSeek。**
那 7 个小时里按 Ollama 空闲价付费，比 DeepSeek 高峰价便宜约 47%。

## 两家单价对账

单位：元 / 百万 token（Ollama 是美元计价，按 `FX_USD_CNY`（默认 7.1）折算）。

| | DeepSeek 高峰 | DeepSeek 空闲 | Ollama 高峰 | Ollama 空闲 |
|---|---|---|---|---|
| 未命中输入 | 2.00 | 1.00 | 2.130 | 1.065 |
| 缓存命中输入 | 0.0400 | 0.0200 | 0.0426 | 0.0213 |
| 输出 | 8.00 | 4.00 | 8.52 | 4.26 |

- DeepSeek：[定价页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) 的 deepseek-flash 行，空闲 = 高峰的一半。
- Ollama：[模型页](https://ollama.com/library/deepseek-v4.1-flash) 的 Cost/1M tokens，`$0.30 / $0.006 / $1.20`（高峰），空闲同样减半。

看出来的两件事：**同档位 Ollama 比官方贵约 6%**（所以两家都空闲时仍走官方），
真正的差价只来自"官方高峰 × Ollama 空闲"这个组合；而路由保证了**每一刻用的都是某一家
的空闲价**，所以不需要再拿高峰价当参照物了。

## 看板：现在什么模型 / 用了多少 / 花了多少 / 还剩多少

浏览器打开 **<http://127.0.0.1:8788/>**，一页四块，每 5 秒自动刷新：

| 区块 | 内容 |
|---|---|
| 当前模型 | 上游（DeepSeek 官方 / Ollama Cloud）+ 真实模型名（`deepseek-flash` / `deepseek-v4.1-flash`）+ 为什么选它 + 下次切换时间 |
| 推理档位 | 最近一次请求实际下发的 `thinking` 与 `reasoning_effort`，以及各档累计次数 |
| 用了多少 / 花了多少 | 本次运行、今日、近 7 天、累计：请求数、输入 token（含缓存命中）、输出 token、人民币花费，以及**官方 / Ollama 各花了多少** |
| 按上游 | 「今日 / 近 7 天 / 累计」三列 × 「DeepSeek 官方 / Ollama Cloud」两行：各自的请求数、token、花费（DSH 插件只能看到 `time-router:auto` 一行，上游拆分看这里） |
| 还剩多少钱 | DeepSeek 账户余额（¥）、Ollama 套餐剩余额度（$）与到期日 |

带 `x-router-force` 的手动测试请求**单独计数**（看板上写「另有测试 N 次 ¥x」），
不进 `requests`、不进 `byProvider`、也不进 `stats.json` 的历史——免得调试把账搅乱。

原始 JSON：`/_router/status`（当前选择）、`/_router/stats`（用量与花费）、
`/_router/balance`（余额）。

这些数字按**北京日期**记进同目录的 `stats.json`，重启不清零，所以看板上的
「今日 / 近 7 天 / 累计」是跨重启累计的；想清零就删掉这个文件再重启代理。

另外，每个转发出去的响应都带 `x-router-provider` 和 `x-router-model` 头，
用 curl 之类调的时候能直接看到这一条实际发给了谁。

> 注意：DSH 会话里显示的模型名是 `DeepSeek V4.1 Flash (自动选更便宜的一家)`，
> 它只知道"经过路由"，不知道路由最终选了谁——要知道真实上游，看上面的看板或响应头。

## 在 dsh-cost-meter 里给 `auto` 定价（不改插件内核）

DSH 的 `dsh-cost-meter` 插件按 `provider:model` 记账，我们这条就是 `time-router:auto`。
它自己的价格表里没有叫 `auto` 的模型，所以「价格设置」页原来显示 **待设置价格 / 三列 `—`**，
`auto` 的花费一直是 0。

不用改插件代码，走它本来就支持的「自定义价格」即可：

```
priceOverrides['time-router:auto'] = '__custom__'
prices.custom['time-router:auto']  = { currency: 'USD', cacheMiss: 0.15, cacheHit: 0.003, output: 0.6 }
```

单位是 **每百万 token**，`billingMode` 由插件固定为 `flat`（不分高峰/空闲）——
正好符合本代理的事实：任何时刻都落在某一家（或两家）的空闲价上。

这等价于在插件设置页点 `auto` 那行的「设置价格」并填 0.15 / 0.003 / 0.6。命令行版：

```powershell
cd F:\CodeProjects\CodexProjects\ollama-ds-router
node tools\set-cost-meter-price.mjs --dry-run   # 先看要写什么
node tools\set-cost-meter-price.mjs             # 写进 <DSH_HOME>\storages\cost-meter\ledger.json（自动备份）
```

为什么是这三个数：DeepSeek 空闲价 **1 / 0.02 / 4 元**每百万，Ollama 空闲价
**$0.15 / $0.003 / $0.60** 每百万；插件汇率按 6.6723 折算，1 元 ≈ $0.1499，
两边几乎相等，所以用 `0.15 / 0.003 / 0.6` 美元报出来的钱和实际扣的钱差不到 1%。
插件读到新配置后会自己刷新（账本文件按 mtime 三方合并），不用重启 DSH。

**看不到"两个上游各用了多少"**：插件只能看到 DSH 这一层的 `time-router:auto`，
响应里真实是 `deepseek-flash` 还是 `deepseek-v4.1-flash` 它拿不到（试过让上游在
响应体里改 `model`，DSH 仍按会话里的模型 id 记账）。所以按上游拆分的账在本代理
看板的「**按上游**」表格里：今日 / 近 7 天 / 累计 × 官方 / Ollama，各自的请求数、token、花费。

## 图片与推理档位（DSH 侧）

两家的上游模型其实是同一个 **DeepSeek-V4.1-Flash-1017**（官方文档标注 Vision ✓），
所以 DSH 里 `time-router/auto` 这一条声明成：

```yaml
models:
  - id: auto
    name: DeepSeek V4.1 Flash (自动选更便宜的一家)
    contextWindow: 1000000
    maxTokens: 384000
    input: [text, image]
    reasoningEfforts: {off: null, low: low, high: high, max: max}
    compat: {thinkingFormat: deepseek, maxTokensField: max_tokens,
             requiresReasoningContentOnAssistantMessages: true,
             supportsStore: false, supportsDeveloperRole: false}
```

- **不写 `input: [text, image]`，DSH 就默认当纯文本模型**，贴图会提示"当前模型不支持图片"。
- **不写 `reasoningEfforts`，DSH 就认为不能思考**，模型选择器里没有推理等级。
- **写了 `reasoningEfforts`，菜单就只显示写进去的那几档**——DSH 把没声明的档位
  钉成 `null`（= 不支持），只有 `off` 允许留空（表示"不思考时不发任何参数"）。
  这就是菜单曾经只有 `Off / Low / High` 的原因：漏抄了官方目录里的 `max: "max"`。
  现在的四档与官方目录 `deepseek-v4-flash` 的
  `{minimal: null, low: "low", medium: null, high: "high", max: "max"}` 逐字段一致，
  `minimal` / `medium` / `xhigh` 不提供。
- `compat.thinkingFormat: deepseek` 让 DSH 用 `thinking: {type: enabled/disabled}` 开关思考
  （而不是 OpenAI 的 `reasoning_effort`），两家网关都认这一套。

改完 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 后需要**重启 DSH**才生效。

### 怎么证明"现在真的是 Max"

推理档位就是请求体里的两个字段，代理不改写它们（只换 `model`），所以看代理就能看到 DSH 到底发了什么：

| 看哪里 | 看到什么 |
|---|---|
| 看板 `http://127.0.0.1:8788/` | 「最近一次请求 · 推理档位」卡片显示 `max`，下面一行 `thinking=enabled · DeepSeek 官方 · 00:41:10　各档累计：max×2` |
| `router.log` 每行 | `→ deepseek  Ollama 高峰 + DeepSeek 空闲（半价）  [stream]  思考 enabled / effort=max` |
| `GET /_router/stats` | `lastEffort: {provider, thinking:"enabled", effort:"max"}`、`byEffort: {"max":2}` |

链路是：DSH 里选 Max → 按 `thinkingLevelMap.max = "max"` 下发 `reasoning_effort: "max"` →
代理原样转发（只换 `model`）→ 上游收到 `"max"`。在 DSH 里选一档、发一句话，看板出现同名档位，这条链就闭合了。

第二条证据来自上游自己的校验：DeepSeek 把 `reasoning_effort` 当**枚举**解析，填个不存在的值直接 422：

```
HTTP 422 {"error":{"message":"Failed to deserialize the JSON body into the target type:
reasoning_effort: unknown variant `bogus`, expected one of `none`, `minimal`, `low`,
`medium`, `high`, `xhigh`, `ultra`, ..."}}
```

不认识的档位会被拒，说明这个参数是真的被解析并生效，不是"传了也白传"；
`max` 能稳定拿 200，就是被接受的那个档位（官方映射表 `max → max`，不开着默认是 `high`）。

> 别拿"思考字数多少"当证据：简单问题上 low 和 max 的 CoT 长度几乎一样
> （实测 low 153 / max 145 reasoning tokens），这个指标在简单任务上区分不出来。

## 文件

| 文件 | 作用 |
|---|---|
| `schedule.mjs` | 纯时间规则，无网络依赖；`node schedule.mjs --test` 跑边界用例 |
| `router.mjs` | 本地 OpenAI 兼容代理，按规则转发 + 失败回退 + 用量记账 |
| `probe.mjs` | 两家 API 的兼容性冒烟测试（tools / 流式 / 缓存） |
| `test-local.mjs` | 用假上游回归测试路由逻辑，不联网不花钱 |
| `holidays.json` | 中国法定节假日表（这些天 DeepSeek 全天空闲，路由全天走官方）；已含 2027 全年，改后自动重载 |
| `stats.json` | 按北京日期累计的用量账本，自动生成；删掉即清零 |
| `setup.mjs` / `setup.cmd` | 一键部署：找回 key、验证、写 `.env`、装自启、启动、查 DSH 配置 |
| `start.cmd` / `run-hidden.vbs` | 前台启动 / 无窗口后台启动 |
| `restart.cmd` | 改完代码后重启：杀掉 8788 上的进程再后台拉起，等 `/status` 返回 200 |
| `tools\set-cost-meter-price.mjs` | 给 dsh-cost-meter 的 `time-router:auto` 写自定义价格（见上文） |
| `tools\restart-later.mjs` | 延迟 N 秒重启（默认 150），用于"手头正在流式返回，别现在掐断" |
| `mode.json` | 当前运行模式（`auto-ds` / `auto-ollama` / `ollama` / `deepseek`），托盘或看板里一改就写这里；删掉即回到 `auto-ds` |
| `test-modes.mjs` | 四模式调度用例，`node test-modes.mjs`，6 个断言，不联网 |
| `tray\RouterTray.exe` | 托盘小工具（C++ 单文件，**已编好入库**，182 KB / x86 静态 CRT / Win7–Win11 免安装）：切模式、看余额、看两家高峰期；`--tray` 启动即隐藏窗口 |
| `autostart\` | 计划任务 `Ollama-DS-Router` 的入口：`router-hidden.vbs` → `router-loop.cmd`（守护循环，node 崩了 5 秒拉起） |
| `.env.example` | 两个 key 的模板 |

## 一键部署（推荐）

```powershell
cd F:\CodeProjects\CodexProjects\ollama-ds-router
.\setup.cmd
```

只问你要 **Ollama 的 key**（输入时打星号）。DeepSeek 官方 key 会按这个顺序自动找：
环境变量 → `.env` → DSH 凭证库 `C:\Users\<你>\.dsh\.credentials.yaml`。

脚本会：各发一个 `max_tokens=1` 的请求验证两个 key（花费可忽略）→ 写 `.env` →
装自启（已经有计划任务 `Ollama-DS-Router` 就跳过「启动」文件夹，避免登录时起两份）→ 立刻拉起代理并检查健康 → 检查 DSH 配置。

- 验证失败会告诉你 HTTP 状态和原因，可以选继续或取消，也可 `node setup.mjs --force`。
- 只想看会做什么：`node setup.mjs --dry-run`。
- 撤销自启：`node setup.mjs --uninstall`（不删文件、不删 key）。
- 自启坏了（登录后没起来）：`node setup.mjs --startup-only` 只修自启（有计划任务就跳过「启动」文件夹）。
- key 不要贴进聊天/issue，直接在本机终端输入。

## 第一步：冒烟测试

先确认 Ollama 的 OpenAI 兼容端点能扛住 DSH 真正会用的东西（function tools、工具结果回填、SSE、usage）。

```powershell
cd F:\CodeProjects\CodexProjects\ollama-ds-router
$env:DEEPSEEK_API_KEY="sk-..."
$env:OLLAMA_API_KEY="..."
node probe.mjs
```

只测一家：`node probe.mjs --only=ollama`。

看结果里的 `2. function tools` 和 `3. tool 结果回填`——这两项不过，就别接 Ollama。
每次运行花几分钱。

## 第二步：启动路由（手动方式）

一键部署已经做了这一步，下面是不想用脚本时的手动流程。复制 `.env.example` 为 `.env`
并填两个 key，然后：

```powershell
.\start.cmd
```

启动后会打印当前选择、下次切换时间、两家 key 状态。浏览器打开
<http://127.0.0.1:8788/> 是看板（当前用哪家 + 花费 + 余额），
`/_router/status` 是纯 JSON。

看花了多少、还剩多少：<http://127.0.0.1:8788/>（看板），或 `/_router/stats`（纯 JSON）。

它统计每个请求的 prompt / 缓存命中 / completion token，按当时的档位折算成人民币：

```json
{
  "requests": 128,
  "actualCny": 0.4123,
  "tokens": { "input": 1420000, "cached": 1380000, "output": 9200 },
  "byProvider": { "deepseek": { "...": 0 }, "ollama": { "...": 0 } }
}
```

`stats.json` 按北京日期累计，重启不清零；控制台每行日志也会带本次 token 数和花费。

余额：<http://127.0.0.1:8788/_router/balance>（60 秒缓存）。DeepSeek 查
`GET /user/balance`（元），Ollama 查 `GET /api/balance`（套餐额度 / 已购），两家一起返回，
失败的那家给 `ok: false` 和原因，不影响主链路。

自检（不联网）：

```powershell
node schedule.mjs --test     # 时间规则边界
node test-local.mjs          # 路由 / 映射 / 回退 / 流式
```

## 第三步：接进 DSH

**已经替你加好了。** `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`
里的 `llm-pi-ai` 现在多了一条 `time-router` 路由，原文件备份在同目录
`cordis.patch.yml.bak-20261105-194302`。

```yaml
      time-router:
        displayName: 时间路由 (DS/Ollama)
        apiKeyEnv: TIME_ROUTER_API_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:8788/v1
        models:
          - id: auto
            name: DeepSeek V4.1 Flash (自动选更便宜的一家)
            contextWindow: 1000000
            maxTokens: 384000
            input: [text, image]
            reasoningEfforts: {off: null, low: low, high: high, max: max}
            compat: {thinkingFormat: deepseek, maxTokensField: max_tokens,
                     requiresReasoningContentOnAssistantMessages: true,
                     supportsStore: false, supportsDeveloperRole: false}
```

`models` 里那几行别删：`input` 决定能不能贴图、`reasoningEfforts` 决定菜单里有哪几档、
`compat` 决定思考开关怎么下发（详见上面「图片与推理档位」）。

`TIME_ROUTER_API_KEY` 已经用 `setx` 设成 `local-router-no-auth`（代理不校验它，
只是 DSH 要求路由必须有一个凭证引用）。

**重启 DSH** 生效，然后在模型选择里选「时间路由 / auto」即可。

想撤销：把 `.bak` 文件覆盖回去，并删掉用户环境变量 `TIME_ROUTER_API_KEY`。

### 开机自启（可选）

跑过 `node setup.mjs` 的话已经装好了：计划任务 **Ollama-DS-Router**
（登录时触发，并且每 1 分钟重复一次做自愈）会启动 `autostart\router-hidden.vbs`，
它再静默拉起守护进程 `tools\supervisor.mjs`（无窗口）。不用 `shell:startup` 里的 vbs 了。

守护进程负责四件事，都在 `autostart\router-supervisor.log` 里留痕：

| 能力 | 说明 |
|---|---|
| 单实例 | 靠绑控制端口 8790 判断；第二个守护发现端口被占且回包含 `router-supervisor` 就直接退出 |
| 崩溃重启 | 子进程 `node router.mjs` 退出后 5 秒重拉 |
| 健康检查 | 每 30 秒打一次 `/_router/status`，连续 3 次失败就杀掉子进程强制重启 |
| 日志轮转 | 超过 5MB（`ROUTER_LOG_MAX_BYTES`）改名为 `.1` 后重开 |

端口 8788 若被别的进程占着（比如手动开的 `node router.mjs`），守护不会去抢，只每 30 秒探一次，
等它释放后接管——所以**只从计划任务启动**，别手动起路由，否则会出现"无守护"的实例。

手动排查：`schtasks /run /tn "Ollama-DS-Router"`，然后看 `autostart\router-supervisor.log` 的头两行。

## 运行模式与托盘小工具

路由器有四种模式，切换**立即生效**（下一个请求就按新模式走，不需要重启）：

| 模式 | 空闲时（两家都不是高峰） | 说明 |
|---|---|---|
| `auto-ds`（默认） | DeepSeek 官方 | 只有 DeepSeek 高峰（工作日 09:00–12:00、14:00–18:00）才切 Ollama |
| `auto-ollama` | Ollama Cloud | 只有 Ollama 高峰（工作日 20:00–次日 02:00）才切官方 |
| `ollama` | Ollama Cloud | 强制，不看时间 |
| `deepseek` | DeepSeek 官方 | 强制，不看时间 |

周末两天都不算高峰；法定节假日只影响 DeepSeek（这些天官方全天空闲）。

三种切换方式：

- **托盘小工具**（推荐）：双击 `tray\RouterTray.exe`，四个单选一点就切；窗口里还有两家余额、今天用了多少次/多少钱、两家的高峰时段（正在高峰的那行标红）。右键托盘图标也能切；勾掉「在托盘区显示图标」就不占托盘，关窗口即缩到托盘、退出走右键菜单。
  右键菜单还有 **打开看板（浏览器）** 和 **复制状态到剪贴板**（当前模式 / 生效上游 / 下次切换 / 两家余额 / 今天次数与花费，粘到哪里都是一段现成的话）。
  托盘圆点颜色：蓝 = DeepSeek 官方，绿 = Ollama，灰 = 连不上路由器，**黄 = 某一家余额低了**（DeepSeek < ¥5 或 Ollama < $5，同时气泡提醒一次；余额回上去后再低会重新提醒）。
- **浏览器看板**：`http://127.0.0.1:8788/` 顶部有四个切换链接。
- **命令行**：`curl "http://127.0.0.1:8788/_router/prefer?prefer=auto-ollama"`（也可 POST JSON `{"prefer":"ollama"}`）；`curl http://127.0.0.1:8788/_router/mode` 看纯文本快照（当前模式 / 生效上游 / 下次切换 / 余额）。

托盘小工具不用装 VS2019——仓库里的 `tray\RouterTray.exe` 是编好的，clone 下来直接双击；只有要改它的代码才需要跑 `tray\build.cmd`。

托盘小工具想开机自启：把 `RouterTray.exe --tray` 的快捷方式放进「启动」文件夹（本机已经放好：`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\RouterTray.lnk`）。

## 行为细节

- **回退**：主线路返回 400/404/422（参数方言不被接受）、429/5xx、连不上、首字节超时
  （默认 60s，`ROUTER_FIRST_BYTE_TIMEOUT_MS`）、流中途超过 120s 没有新数据（`ROUTER_IDLE_TIMEOUT_MS`），
  自动换另一家重试；已经吐了字节就不再重试（避免半截输出，只记日志）。
- **最近请求**：`GET /_router/recent` 返回内存里最近 20 条（`ROUTER_RECENT_MAX`），
  成功记上游/耗时/缓存命中/花费，失败记状态码/是否溢出/原因；看板底部也有最近 10 条。
  只放内存，重启即清空。
- **统计保留**：`stats.json` 按天分桶，超过 `ROUTER_STATS_KEEP_DAYS`（默认 365）天的旧桶在启动时裁掉。
- **模型名映射**：请求里的 `auto`、`deepseek-flash`、`deepseek-v4.1-flash`
  都会映射成当前上游的真实模型名；其他名字原样透传。
- **强制指定**（测试用）：请求头 `x-router-force: ollama` 或 `?force=deepseek`。
- **多轮切换**：跨过边界后下一次请求就换家，不需要重启；代价是新上游缓存冷一次
  （约一次全价输入，可忽略）。
- **节假日**：`holidays.json` 里列出的日期，DeepSeek 当天全天空闲 → 全天走官方。
  默认是空数组，按国务院放假安排自己加，例如 `"holidays": ["2026-10-01", "2026-10-02"]`。
- **调时钟测试**：`ROUTER_CLOCK_OFFSET_MS=3600000` 会把路由看到的"现在"整体前移一小时，
  用来在任意时刻验证切换，不影响真实时间。

## 出问题时

- **DSH 报 `502 … ECONNREFUSED 127.0.0.1:8788`**：代理没在跑。`schtasks /run /tn "Ollama-DS-Router"`
  拉起来，再看 `autostart\router-supervisor.log`；或者 `node setup.mjs --startup-only` 修好自启后重启 DSH。
- **路由没起来**：先看 `autostart\router-supervisor.log`（守护和路由的全部输出都在里面，含轮转后的 `.1`）；
  再试前台 `node --env-file=.env router.mjs`，报错会直接打在屏幕上。
  `router.log` 里如果是 `'--env-file' 不是内部或外部命令`，说明启动脚本被改坏了
  （`.vbs` 里不能写中文注释，wscript 按 GBK 读会把语句吃掉），跑
  `node setup.mjs --startup-only` 重新生成一份即可。
- **端口被占**：`netstat -ano | findstr :8788`，找到 PID 后 `taskkill /PID <pid> /F`。
  注意别 `taskkill /IM node.exe`，会连别的 Node 程序一起杀掉。
- **`--env-file` 报未知参数**：Node 低于 20.6，升级 Node 或者用
  `set DEEPSEEK_API_KEY=... && set OLLAMA_API_KEY=... && node router.mjs`。
- **DSH 里看不到「时间路由」**：改完 `cordis.patch.yml` 要重启 DSH。
- **DSH 报「上游流在完成事件之前就结束了」或回包乱码**：这是上游用 gzip 压缩、
  代理又把 `content-encoding` 原样传给客户端导致的（客户端拿明文当 gzip 解）。
  已修：代理不再透传 `content-encoding` / `content-length`，改完重启一次代理即可。
  `node test-local.mjs` 里有一条专门的回归用例（上游 gzip 时应仍能读到完整 SSE）。
- **`/_router/balance` 返回 401**：Ollama key 无效，重新跑 `setup.cmd`（会先验证再写）。

## 已知风险

1. **并发**：Ollama pay-as-you-go 只有 3 并发，而 DSH 是 `maxParallelToolCalls: 6`
   + 最多 5 个 subagent。高并发时会 429，然后回退到 DeepSeek——功能不断，只是那一波省不到。
2. **数据出境**：走 Ollama 时代码会到它美国的机房。
3. **法定节假日**：`holidays.json` 已填好 2027 年全部 29 天（依据[国办发明电〔2026〕10号](https://www.gov.cn/zhengce/content/202611/content_7085101.htm)），
   改完保存即自动重载、不用重启。2027 年之后要自己补：每年 11 月国务院办公厅发通知，把日期加进数组即可。
4. **兼容性**：Ollama 的 OpenAI 端点只是子集，先跑 `probe.mjs` 再决定。
5. **首字节前断流**：上游先回 200 头、却在吐任何数据之前掐断连接时，代理会在一个字节都没发给客户端的情况下撤掉响应头、换另一家重试；已经吐过数据的流中断则只记日志（不能重试）。
