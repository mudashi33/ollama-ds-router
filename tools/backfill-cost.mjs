// 把 dsh-cost-meter 账本里 time-router:auto 这一档按「自定义价格」重算，
// 补上「价格设置之前被记成 0」的那部分钱。只动 time-router:auto，不碰其它渠道。
//
// 用法：node tools/backfill-cost.mjs [--dry-run] [--day 2026-11-06] [--all]
// 默认只处理北京时间今天的桶；--all 处理全部历史日期。
// 写之前自动备份 ledger.json，写入用 tmp+rename 原子替换。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const LEDGER =
  process.env.DSH_COST_LEDGER ||
  path.join(os.homedir(), '.dsh', 'storages', 'cost-meter', 'ledger.json')
const KEY = 'time-router:auto'

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const allDays = argv.includes('--all')
const iDay = argv.indexOf('--day')
const dayArg = iDay >= 0 ? argv[iDay + 1] : null

const beijingToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
const targetDays = dayArg ? [dayArg] : allDays ? Object.keys(ledger.days || {}).sort() : [beijingToday()]

const ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8'))
const cfg = ledger.config || {}
const custom = (cfg.prices?.custom?.[KEY]) || {}
const price = {
  miss: Number(custom.cacheMiss ?? 0.15),
  hit: Number(custom.cacheHit ?? 0.003),
  out: Number(custom.output ?? 0.6),
}
const fx = Number(cfg.exchangeRate ?? 6.6723)

// EUR 汇率：从账本里已有的渠道反推（costEur / cost），推不出来就用 0.8875
let eurRate = 0.8875
for (const d of Object.values(ledger.days || {})) {
  for (const e of Object.values(d.byProviderModel || {})) {
    if (e.cost > 0 && e.costEur > 0) {
      eurRate = e.costEur / e.cost
      break
    }
  }
  if (eurRate !== 0.8875) break
}

const trueCost = (e) =>
  ((e.input || 0) * price.miss + (e.cacheRead || 0) * price.hit + (e.output || 0) * price.out) / 1e6

const needs = []
for (const day of targetDays) {
  const d = ledger.days?.[day]
  if (!d) continue
  const holders = [
    ['当天合计', d],
    ...(d.sessions || []).map((s) => [s.id.slice(0, 26), s]),
  ]
  for (const [label, holder] of holders) {
    const e = holder.byProviderModel?.[KEY]
    if (!e) continue
    const truth = trueCost(e)
    const rec = e.cost || 0
    const delta = truth - rec
    if (Math.abs(delta) < 1e-9) continue
    needs.push({ day, label, holder, e, truth, delta })
  }
}

console.log(
  `价格：未命中 $${price.miss} / 命中 $${price.hit} / 输出 $${price.out}（每百万 token）· 汇率 ${fx} · EUR ${eurRate.toFixed(6)}`,
)
if (!needs.length) {
  console.log('不需要补：账本里的数已经和价格表一致')
  process.exit(0)
}
for (const n of needs) {
  console.log(
    `${n.day} ${n.label.padEnd(28)} 记账 $${(n.e.cost || 0).toFixed(6)} → 应为 $${n.truth.toFixed(6)}　补 $${n.delta.toFixed(6)}（¥${(n.delta * fx).toFixed(4)}）`,
  )
}
const totalDelta = needs.filter((n) => n.label === '当天合计').reduce((a, n) => a + n.delta, 0)
console.log(`\n合计补 $${totalDelta.toFixed(6)}（¥${(totalDelta * fx).toFixed(4)}）· 明细行含当天合计与会话两级的同一笔钱`)

if (dryRun) {
  console.log('--dry-run：没有写文件')
  process.exit(0)
}

for (const { holder, e, truth, delta } of needs) {
  e.cost = truth
  e.apiCost = truth
  e.costCny = truth * fx
  e.apiCostCny = truth * fx
  e.costEur = truth * eurRate
  e.apiCostEur = truth * eurRate
  holder.cost = (holder.cost || 0) + delta
  holder.apiCost = (holder.apiCost || 0) + delta
  holder.costCny = (holder.costCny || 0) + delta * fx
  holder.apiCostCny = (holder.apiCostCny || 0) + delta * fx
  holder.costEur = (holder.costEur || 0) + delta * eurRate
  holder.apiCostEur = (holder.apiCostEur || 0) + delta * eurRate
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')
const bak = `${LEDGER}.bak-${stamp}`
fs.copyFileSync(LEDGER, bak)
const tmp = `${LEDGER}.tmp-${process.pid}`
fs.writeFileSync(tmp, JSON.stringify(ledger))
fs.renameSync(tmp, LEDGER)
console.log(`已写入 ${LEDGER}\n备份：${bak}`)
