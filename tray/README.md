# 时间路由 · 模式切换托盘小工具

一个单文件 Windows 小工具（`RouterTray.exe`，x86，静态链接 CRT，无需任何运行库，Win7–Win11 可用），
用来遥控本机的 ollama-ds-router（`http://127.0.0.1:8788`）：切换用哪家模型、看余额、看高峰时段。

## 怎么用

- **托盘图标**（任务栏右下角的小圆点，颜色表示当前在用哪家）：
  - 蓝色 = DeepSeek 官方
  - 绿色 = Ollama Cloud
  - 灰色 = 连不上路由器（路由器没启动）
  - **黄色 = 某一家余额偏低**（DeepSeek < ¥5 或 Ollama < $5），同时弹一次气泡提醒
  - **双击** = 打开窗口；**右键** = 菜单（四个模式 / 打开窗口 / 打开看板 / 复制状态 / 退出）
- **窗口**：
  - 四个模式单选，点一下就生效，不会打断正在生成的回答
  - 「当前生效 / 正在使用 / 下次切换」实时显示
  - 两行高峰时段，正在高峰的那一行变红并标「← 现在就是」
  - DeepSeek 余额、Ollama 余额（含套餐额度与到期日）、今天请求数与花费
  - 勾选框「在托盘区显示图标」：取消勾选就完全退出托盘，设置记在注册表里
  - 关闭窗口（X）只是缩到托盘；**要真正退出请用托盘右键 → 退出**
- 数据每 3 秒自动刷新，全部来自路由器的 `/_router/mode` 文本快照。
- 右键菜单 **打开看板（浏览器）** 直接开 `http://127.0.0.1:8788/`；
  **复制状态到剪贴板** 把「模式 / 生效上游 / 下次切换 / 两家余额 / 今天次数与花费」拼成一段话复制走。

## 四个模式

| 模式 | key | 含义 |
| --- | --- | --- |
| 自动 · 以 DS 空闲为准 | `auto-ds` | DS 高峰时走 Ollama，其余（含两家都空闲）走官方 |
| 自动 · 以 Ollama 空闲为准 | `auto-ollama` | Ollama 高峰时走官方，其余（含两家都空闲）走 Ollama |
| 强制 Ollama | `ollama` | 一直走 Ollama Cloud |
| 强制 DeepSeek 官方 | `deepseek` | 一直走官方 |

高峰：DeepSeek 工作日 09:00–12:00、14:00–18:00；Ollama 工作日 20:00–次日 02:00；周末都不算高峰。

## 命令行方式（等价）

```bash
curl "http://127.0.0.1:8788/_router/mode"                     # 看当前状态
curl "http://127.0.0.1:8788/_router/prefer?prefer=auto-ollama" # 切模式
```

## 开机自启

启动文件夹里有一个快捷方式：

`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\RouterTray.lnk`

它带 `--tray` 参数，开机只出现在托盘、不弹窗。不想自启就删掉这个快捷方式。

## 重新编译

```cmd
build.cmd
```

需要 VS2019（本机在 `D:\Visual Studio`，x86 工具链）。产物 `RouterTray.exe` 约 178 KB。

## 日志

托盘注册诊断日志：`%LOCALAPPDATA%\OllamaDsRouterTray\tray.log`
（每次 NIM_ADD / NIM_DELETE 一行，含图标矩形，正常形如
`NIM_ADD ok=1 hr=0x00000000 rect=…`）
