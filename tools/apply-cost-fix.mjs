// 修正 cost-meter 账本里的历史花费，需要「先关 DSH、改账本、再开 DSH」——
// 因为插件把当天的合计放在内存里，运行期间会用自己的数覆盖文件。
//
// 用法：node tools/apply-cost-fix.mjs [--delay 75] [--dry-run]
// 流程：等 N 秒 → 结束 DSH（DeepSeek Harness.exe）→ 确认退出 → 跑 backfill-cost.mjs → 重新启动 DSH
// 日志写到同目录 cost-fix.log。
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const LOG = path.join(HERE, 'cost-fix.log')
const DSH_EXE = process.env.DSH_EXE || 'D:\\DeepSeek Harness\\DeepSeek Harness.exe'
const DSH_IMAGE = 'DeepSeek Harness.exe'
const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const iDelay = argv.indexOf('--delay')
const delay = Number(iDelay >= 0 ? argv[iDelay + 1] : 75) * 1000

const note = (msg) => {
  const line = `${new Date().toISOString()} ${msg}`
  try {
    fs.appendFileSync(LOG, `${line}\n`)
  } catch {
    /* ignore */
  }
  console.log(line)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const running = () => {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${DSH_IMAGE}`], { encoding: 'utf8' })
    return out.includes(DSH_IMAGE)
  } catch {
    return false
  }
}

if (dryRun) {
  note(`[dry-run] 会等 ${delay / 1000}s → 结束 ${DSH_IMAGE} → 跑 backfill-cost.mjs → 重启 ${DSH_EXE}`)
  note(`[dry-run] 现在 DSH 是否在运行：${running()}`)
  process.exit(0)
}

note(`开始：${delay / 1000} 秒后结束 DSH 并修正账本（代理不受影响）`)
await sleep(delay)

if (running()) {
  note('结束 DSH …')
  try {
    execFileSync('taskkill', ['/IM', DSH_IMAGE, '/F', '/T'], { stdio: 'ignore' })
  } catch (err) {
    note(`taskkill 报错（可能已经退出）：${err.message}`)
  }
} else {
  note('DSH 当前没在运行，直接改账本')
}

let gone = false
for (let i = 0; i < 30; i++) {
  await sleep(1000)
  if (!running()) {
    gone = true
    break
  }
}
note(gone ? 'DSH 已退出' : '警告：30 秒内 DSH 仍在运行，仍继续改账本（可能被覆盖）')

try {
  const out = execFileSync(process.execPath, [path.join(HERE, 'tools', 'backfill-cost.mjs')], { encoding: 'utf8' })
  note(`账本修正输出：\n${out.trim()}`)
} catch (err) {
  note(`账本修正失败：${err.message}\n${err.stdout || ''}${err.stderr || ''}`)
  note('DSH 未启动，请手动打开（账本已备份）')
  process.exit(1)
}

await sleep(1500)
note(`重新启动 DSH：${DSH_EXE}`)
const child = spawn(DSH_EXE, [], { detached: true, stdio: 'ignore', cwd: path.dirname(DSH_EXE) })
child.unref()

let up = false
for (let i = 0; i < 40; i++) {
  await sleep(1000)
  if (running()) {
    up = true
    break
  }
}
note(up ? 'DSH 已重新启动' : 'DSH 40 秒内没起来，请手动打开')
