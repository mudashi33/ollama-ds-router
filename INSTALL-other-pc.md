# 在另一台电脑上安装 ollama-ds-router

把下面 **整段** 复制给那台电脑上的 AI（Claude / Codex / DSH 都行）。

```text
背景：这台电脑上要把 ollama-ds-router 装到 F:\CodeProjects\DeepseekHarnessProjects\ollama-ds-router，
并接进 DeepSeek Harness（DSH）当模型上游。这是一个本地 OpenAI 兼容的"时间路由"代理：
按北京时间把请求分给 DeepSeek 官方或 Ollama Cloud（两家高峰期错开，自动切到空闲的那家），
端口 8788，带看板、余额、四模式切换和 Windows 托盘小工具。

源码：GitHub 私有仓库 https://github.com/mudashi33/ollama-ds-router
仓库里没有 .env（密钥不入库，需要你自己建）；托盘程序 tray\RouterTray.exe 已经编好入库
（182 KB，x86 静态 CRT，Win7-Win11 免安装），clone 下来双击就能用。

硬性要求：
1. 每一步都实际执行，把命令和输出贴给我，不要只说"应该可以"；报错就贴原文再排查，不许跳过。
2. 修改任何 DSH 配置前先备份：把 cordis.patch.yml 复制成 cordis.patch.yml.bak-<今天日期>。
3. API key 由我自己填进 .env：你不要向我要 key，也不要把 key 打印到聊天、日志或命令回显里；
   不要 cat/type/Get-Content 整个 .env。
4. 不要 npm install、不要 pnpm install —— 这个项目零运行时依赖，只用 Node 内置模块。
5. 不要改 DSH 的 contextWindow / maxTokens（保持 1048576 / 256000，这是我确认过的值）。
6. 仓库是私有的：如果 clone 报认证失败（403 / could not read Username），停下来告诉我，
   我自己去 gh auth login 或换方式，不要尝试绕开认证。
7. 装完只报告事实：每条验收的实际输出，不要写"应该没问题"。

环境前提（先核查，缺什么告诉我）：
- node -v 必须 >= 22.19（项目 engines 要求 ^22.19.0 || >=24.0.0）
- git --version
- 能找到 DSH 的 profile 目录（一般是 %USERPROFILE%\.dsh\profiles\desktop）
- 托盘不用额外环境（exe 已入库）；只有想改托盘代码才需要 VS2019 + Windows SDK（x86 工具链）

步骤（按顺序做，每步验证后再进下一步）：

1) 取源码
   mkdir F:\CodeProjects\DeepseekHarnessProjects（若不存在）
   git clone https://github.com/mudashi33/ollama-ds-router.git F:\CodeProjects\DeepseekHarnessProjects\ollama-ds-router
   如果直连 GitHub 超时或被 reset，改用本机代理重试（端口按实际代理软件填，例如 Clash 常见 7897）：
   git -c http.proxy=http://127.0.0.1:7897 clone ...
   验证：cd 进去，git log --oneline -1 能看到提交；tray\RouterTray.exe 存在且是 182,784 字节。

2) 自检（项目自带测试，不需要任何依赖）
   node schedule.mjs --test     → 期望 13/13 PASS（高峰判定、节假日、边界时刻）
   node test-local.mjs          → 期望 11/11 PASS（429 回退、参数方言回退、SSE 透传、gzip 头、成本计算、双失败 503 等）
   任何一条失败：把完整报错贴给我，不要继续。

3) 配置密钥（交接点：这里必须停下来等我）
   copy .env.example .env
   然后停手，告诉我"请填 .env 里的 DEEPSEEK_API_KEY 和 OLLAMA_API_KEY"，等我填完回复你。
   我填好后你只验证"两个变量非空"，用不打印值的方式。

4) 起服务并验证
   node router.mjs        （前台起，先验证通了再说；不要用 start.cmd，那个是给双击用的）
   验证（另开一个终端）：
   - curl http://127.0.0.1:8788/_router/status  → HTTP 200，能看到 mode / provider
   - curl http://127.0.0.1:8788/_router/balance → deepseek ok、ollama ok，并显示余额
   - curl http://127.0.0.1:8788/_router/mode    → 纯文本快照，含 label、reason、nextSwitch

5) 接进 DSH
   备份：copy <profile>\cordis.patch.yml <profile>\cordis.patch.yml.bak-<日期>
   在文件末尾追加下面这一块（YAML 缩进必须保持，列表项前面是 "- "）：

    - id: llm-pi-ai
      name: "@deepseek-ai/dsh-llm-pi-ai"
      config:
        providers:
          time-router:
            displayName: 时间路由 (DS/Ollama)
            apiKeyEnv: TIME_ROUTER_API_KEY
            api: openai-completions
            baseURL: http://127.0.0.1:8788/v1
            models:
              - id: auto
                name: DeepSeek V4.1 Flash (自动选更便宜的一家)
                contextWindow: 1048576
                maxTokens: 256000
                input:
                  - text
                  - image
                reasoningEfforts:
                  off: null
                  high: high
                  max: max
                compat:
                  supportsStore: false
                  supportsDeveloperRole: false
                  maxTokensField: max_tokens
                  requiresReasoningContentOnAssistantMessages: true
                  thinkingFormat: deepseek

   追加后验证 YAML 能解析（用 profile 里的 node_modules/yaml，或 node -e 读文件后 JSON 化），
   并确认条目数比之前多 1。

6) 环境变量
   setx TIME_ROUTER_API_KEY local-router-no-auth
   （这个值只是占位，路由器本身不校验；DSH 要求 provider 有 apiKeyEnv。）

7) 完全退出并重启 DSH（桌面版要把所有 DeepSeek Harness 进程都结束，不是关窗口）
   重启后在 DSH 模型菜单里应该能看到「时间路由 (DS/Ollama)」→ auto。
   验收：切到这个模型发一句话，然后：
   - curl http://127.0.0.1:8788/_router/stats  → 请求数增加、成功数增加
   - curl http://127.0.0.1:8788/_router/recent → 最新一条 ok:true，带 provider / ms / prompt

8) 托盘小工具（不用装 VS，exe 已在仓库里）
   运行 F:\CodeProjects\DeepseekHarnessProjects\ollama-ds-router\tray\RouterTray.exe
   （带 --tray 参数则只在托盘出现、不弹窗）。
   想开机自启就把它的快捷方式放进 shell:startup，参数填 --tray。
   只有要改托盘代码时才需要 VS2019 + Windows SDK：cd tray && build.cmd，
   注意 build.cmd 里的 VS 路径是按原机器写的，要改成这台机器的实际位置，改完告诉我改了什么。

9) 可选：路由器开机自启
   node setup.mjs            （装计划任务 Ollama-DS-Router：登录触发 + 每分钟自愈，拉起 tools\supervisor.mjs）
   验证：schtasks /query /tn "Ollama-DS-Router" 存在；杀掉 node 进程后 5 秒内自动拉起；
        GET /_router/status 恢复 200。

交付报告请包含：
- node / git 版本
- 两个测试的完整末尾几行（PASS 计数）
- /_router/status 和 /_router/balance 的实际返回
- cordis.patch.yml 追加前后的行数
- DSH 重启后的 /_router/stats 数字
- 任何一步失败：命令、原文报错、你怎么处理的

注意：不要顺便装别的 DSH 插件（比如 dsh-client-next-step-continue），那是另一个任务，这次只做路由器。
```

## 交给 AI 之前，你自己准备两件事

1. **对私有仓库的访问权**：那台机器要么已经 `gh auth login` 过，要么你能在浏览器里登录 GitHub
   完成一次授权，否则 clone 会 403。不想折腾就打包拷过去：
   `git archive -o router.zip HEAD`（**别**打包整个目录，否则 `.env`、`stats.json` 会一起进去）。
2. **两个 API key**（DeepSeek 平台、Ollama Cloud）。提示词里写了到第 3 步会停下来等你填，
   AI 不会向你要，也不会把值打印出来。

## 仓库里有什么 / 没有什么

| 有 | 说明 |
|---|---|
| `router.mjs` `schedule.mjs` `setup.mjs` | 路由器本体、时间调度、自启安装 |
| `tools/supervisor.mjs` | 守护进程（单实例 / 崩溃重拉 / 健康检查 / 日志轮转） |
| `tray/RouterTray.exe` | **已编好**，182 KB，x86 静态 CRT，Win7–Win11 免安装 |
| `test-local.mjs` `schedule.mjs --test` | 自带测试，零依赖，安装后先跑这两条 |

| 没有 | 原因 |
|---|---|
| `.env` | 密钥不入库，用 `.env.example` 自己建 |
| `stats.json` `mode.json` `*.log` | 运行时产物 |
| `tray/*.obj` `*.pdb` `*.ilk` | 编译中间产物 |

## 一个容易踩的坑

Windows 上 **git 不读系统代理设置**。如果 clone 报 `Recv failure: Connection was reset`，
不是仓库权限问题，是网络：用 `git -c http.proxy=http://127.0.0.1:<你的代理端口> clone ...`。
装好之后也建议在该仓库里固化一次：

```cmd
git config --local http.proxy http://127.0.0.1:7897
git config --local http.version HTTP/1.1
```
