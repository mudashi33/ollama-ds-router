// 给 dsh-cost-meter 的 time-router:auto 设成「平坦空闲价」，不改插件内核。
// 用法：node tools/set-cost-meter-price.mjs [--dry-run]
// 原理（插件 lib/pricing.js providerPriceEntryForNormalized）：
//   priceOverrides['time-router:auto'] = '__custom__'
//   prices.custom['time-router:auto']  = { currency, cacheMiss, cacheHit, output }  // 每百万 token
// → billingMode 'flat'：不区分高峰/空闲，正是本代理的实际情况（永远落在某家的空闲价）。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const LEDGER = process.env.COST_METER_LEDGER ||
  path.join(os.homedir(), '.dsh', 'storages', 'cost-meter', 'ledger.json')
const KEY = 'time-router:auto'
const PRICE = { currency: 'USD', cacheMiss: 0.15, cacheHit: 0.003, output: 0.6 }
const dry = process.argv.includes('--dry-run')

const raw = fs.readFileSync(LEDGER, 'utf8')
const ledger = JSON.parse(raw)
const cfg = ledger.config ?? (ledger.config = {})
cfg.priceOverrides = cfg.priceOverrides ?? {}
cfg.prices = cfg.prices ?? {}
cfg.prices.custom = cfg.prices.custom ?? {}

cfg.priceOverrides[KEY] = '__custom__'
cfg.prices.custom[KEY] = { ...PRICE, billingMode: 'flat' }

const out = JSON.stringify(ledger)
if (dry) {
  console.log('would write', LEDGER, 'bytes', raw.length, '->', out.length)
  console.log('priceOverrides', JSON.stringify(cfg.priceOverrides))
  console.log('custom', JSON.stringify(cfg.prices.custom))
} else {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')
  const bak = `${LEDGER}.bak-${stamp}`
  fs.copyFileSync(LEDGER, bak)
  const tmp = `${LEDGER}.tmp-${process.pid}`
  fs.writeFileSync(tmp, out)
  fs.renameSync(tmp, LEDGER)
  console.log('backup ', bak)
  console.log('patched', LEDGER)
  console.log('  priceOverrides', JSON.stringify(cfg.priceOverrides))
  console.log('  custom', JSON.stringify(cfg.prices.custom))
}
