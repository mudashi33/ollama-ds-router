// 延迟重启代理：等当前这一轮对话彻底结束再换进程，避免掐断正在流式返回的响应。
// 用法：node tools/restart-later.mjs [--delay 150]
// 做的事：等待 → 找到监听 8788 的 PID → taskkill /F → cscript run-hidden.vbs 启动 → 轮询 /_router/status
// 结果追加到 router.log，方便事后确认。
import { execSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const LOG = path.join(HERE, 'router.log')
const PORT = process.env.ROUTER_PORT || 8788
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const delay = Number(arg('delay', 150)) * 1000

const note = (msg) => {
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()} [restart-later] ${msg}\n`)
  } catch {
    /* 日志写不了就算了 */
  }
  console.log(msg)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function listeningPids() {
  try {
    const out = execSync(`netstat -ano -p tcp | findstr LISTENING | findstr :${PORT}`, { encoding: 'utf8' })
    return [...new Set(
      out.split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/).pop())
        .filter((pid) => pid && /^\d+$/.test(pid)),
    )]
  } catch {
    return []
  }
}

note(`将在 ${delay / 1000} 秒后重启 ${PORT}`)
await sleep(delay)

const pids = listeningPids()
for (const pid of pids) {
  try {
    execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' })
    note(`已结束 PID ${pid}`)
  } catch (err) {
    note(`结束 PID ${pid} 失败：${err.message}`)
  }
}
await sleep(800)

const child = spawn('cscript', ['//nologo', path.join(HERE, 'run-hidden.vbs')], {
  cwd: HERE,
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
})
child.unref()
note(`已拉起新进程（cscript run-hidden.vbs）`)

let ok = false
for (let i = 0; i < 30; i++) {
  await sleep(1000)
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/_router/status`)
    if (res.ok) {
      const j = await res.json()
      note(`新进程已就绪：${j.provider} · ${j.beijing}`)
      ok = true
      break
    }
  } catch {
    /* 还没起来 */
  }
}
if (!ok) note('新进程 30 秒内没起来，看看 router.log')
