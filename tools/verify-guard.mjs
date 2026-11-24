// verify-guard.mjs —— 等当前对话收尾后，重启路由器并实测 max_tokens 护栏是否生效。
// 用法：node tools/verify-guard.mjs --delay 150 [--port 8788]
//  1) 睡 N 秒  2) taskkill 监听端口的 PID（守护进程 5 秒后自动拉起新代码）
//  3) 轮询 /_router/status  4) 发一条 30 条消息 + max_tokens=1 的探针
//  5) 读 /_router/stats 的 maxTokensGuard  6) 结果写 autostart/guard-verify.txt
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const REPORT = path.join(HERE, 'autostart', 'guard-verify.txt')
const PORT = Number(process.env.ROUTER_PORT || 8788)
// 护栏目标值：跟 router.mjs 的 ROUTER_GUARD_MAX_TOKENS 默认保持一致
const GUARD_TO = Number(process.env.ROUTER_GUARD_MAX_TOKENS || 128000)
const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const lines = []
const say = (m) => {
  lines.push('[' + new Date().toISOString() + '] ' + m)
  try {
    fs.writeFileSync(REPORT, lines.join('\n') + '\n')
  } catch {}
}

function listeningPids() {
  try {
    const out = execSync('netstat -ano -p tcp | findstr LISTENING | findstr :' + PORT, { encoding: 'utf8' })
    return [...new Set(out.split(/\r?\n/).map((l) => l.trim().split(/\s+/).pop()).filter((p) => p && /^\d+$/.test(p)))]
  } catch {
    return []
  }
}

const delay = Number(arg('delay', 150))
say('will restart port ' + PORT + ' in ' + delay + 's')
await sleep(delay * 1000)

for (const pid of listeningPids()) {
  try {
    execSync('taskkill /PID ' + pid + ' /F', { stdio: 'ignore' })
    say('killed pid ' + pid)
  } catch (err) {
    say('kill pid ' + pid + ' failed: ' + err.message)
  }
}

let up = false
let bootAt = null
for (let i = 0; i < 60; i++) {
  await sleep(1000)
  try {
    const r = await fetch('http://127.0.0.1:' + PORT + '/_router/status')
    if (r.ok) {
      up = true
      bootAt = Date.now()
      say('router is back after ~' + (i + 1) + 's')
      break
    }
  } catch {}
}
if (!up) {
  say('FAILED: router did not come back in 60s')
  process.exit(1)
}

// 探针：30 条消息 + max_tokens=1，正是 DSH 被钳位后的形状
const messages = Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: 'm' + i }))
let served = null
let probeStatus = null
try {
  const r = await fetch('http://127.0.0.1:' + PORT + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', max_tokens: 1, messages }),
  })
  probeStatus = r.status
  const j = await r.json()
  served = j?.choices?.[0]?.finish_reason ?? null
  say('probe http ' + probeStatus + ' finish_reason=' + served)
} catch (err) {
  say('probe failed: ' + err.message)
}

await sleep(500)
try {
  const s = await (await fetch('http://127.0.0.1:' + PORT + '/_router/stats')).json()
  const g = s.maxTokensGuard || {}
  say('stats.maxTokensGuard hits=' + g.hits + ' last=' + JSON.stringify(g.last))
  say(g.hits >= 1 && g.last?.from === 1 && g.last?.to === GUARD_TO ? 'RESULT=PASS' : 'RESULT=FAIL')
} catch (err) {
  say('stats failed: ' + err.message)
}
say('startedAt(ms)=' + bootAt + ' now(ms)=' + Date.now())
process.exit(0)
