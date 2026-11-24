// 测试专用小壳：在本进程里触发一次 SIGTERM。
//
// 为什么需要它：Windows 上的 Node 没有真信号，child.kill('SIGTERM') 会直接终止进程，
// router.mjs 里 process.on('SIGTERM') 的 handler 一行都跑不到 —— 那样测出来的
// 「SIGTERM 不丢账」是假的（永远 FAIL，且失败原因和代码无关）。
// process 是 EventEmitter，emit('SIGTERM') 会走完全相同的 handler 分支，
// 所以用它来验「收到信号后先把账本刷下去」。
//
// 用法：node tools/test-sigterm-wrapper.mjs，从 stdin 读到任意内容就 emit SIGTERM。
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.stdin.setEncoding('utf8');
process.stdin.on('data', () => {
  process.stdin.pause();
  process.emit('SIGTERM');
});
process.stdin.on('end', () => process.emit('SIGTERM'));

const here = path.dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(path.join(here, '..', 'router.mjs')).href);
