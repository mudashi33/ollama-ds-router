
import { pickProvider } from 'file:///D:/CodeProjects/DeepseekHarnessProjects/ollama-ds-router/schedule.mjs';
const cases = [
  ['周二 10:00 (DS高峰)', '2026-11-10T10:00:00+08:00'],
  ['周二 13:00 (两家都空闲)', '2026-11-10T13:00:00+08:00'],
  ['周二 15:00 (DS高峰)', '2026-11-10T15:00:00+08:00'],
  ['周二 21:00 (Ollama高峰)', '2026-11-10T21:00:00+08:00'],
  ['周六 13:00 (两家都空闲)', '2026-11-14T13:00:00+08:00'],
];
let pass = 0, fail = 0;
for (const [name, iso] of cases) {
  const d = new Date(iso);
  const ds = pickProvider(d, { preferIdle: 'deepseek' });
  const ol = pickProvider(d, { preferIdle: 'ollama' });
  const legacy = pickProvider(d);
  console.log(name.padEnd(24) + ' auto-ds=' + ds.provider.padEnd(9) + ' auto-ollama=' + ol.provider.padEnd(9) + ' 兼容默认=' + legacy.provider);
}
// 断言
const A = (iso, p) => pickProvider(new Date(iso), { preferIdle: 'ollama' }).provider === p;
const D = (iso, p) => pickProvider(new Date(iso), { preferIdle: 'deepseek' }).provider === p;
const checks = [
  ['auto-ds 空闲→官方', D('2026-11-10T13:00:00+08:00', 'deepseek')],
  ['auto-ollama 空闲→Ollama', A('2026-11-10T13:00:00+08:00', 'ollama')],
  ['auto-ollama DS高峰→Ollama', A('2026-11-10T10:00:00+08:00', 'ollama')],
  ['auto-ollama Ollama高峰→官方', A('2026-11-10T21:00:00+08:00', 'deepseek')],
  ['auto-ds 周末→官方', D('2026-11-14T13:00:00+08:00', 'deepseek')],
  ['auto-ollama 周末→Ollama', A('2026-11-14T13:00:00+08:00', 'ollama')],
];
for (const [n, ok] of checks) { if (ok) pass++; else fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n); }
console.log('pass=' + pass + ' fail=' + fail);
