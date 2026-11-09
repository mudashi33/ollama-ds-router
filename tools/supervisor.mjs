// 时间路由 · 守护进程（supervisor）
//
// 为什么不用 cmd 循环了：
//   1. 老版本 router-loop.cmd 自己被杀掉后没人再拉起它（只能等下次登录）；
//   2. 计划任务每分钟触发一次 + 这里的「控制端口互斥」，天然解决"谁在守"的问题：
//      已经在守的那个进程占着控制端口，新起来的会立刻退出。
//
// 职责：端口探活 → 起 node router.mjs → 挂了就重启 → 日志按大小轮转。
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ROUTER = path.join(ROOT, 'router.mjs');

const PORT = Number(process.env.ROUTER_PORT || 8788);
const HOST = process.env.ROUTER_HOST || '127.0.0.1';
const CONTROL_PORT = Number(process.env.ROUTER_SUPERVISOR_PORT || 8790);
const LOG = process.env.ROUTER_SUPERVISOR_LOG || path.join(ROOT, 'autostart', 'router-supervisor.log');
const LOG_MAX = Number(process.env.ROUTER_LOG_MAX_BYTES || 5 * 1024 * 1024);
const NODE = process.env.NODE_EXE || process.execPath;
const CHECK_MS = Number(process.env.ROUTER_SUPERVISOR_CHECK_MS || 30000);
const RESTART_MS = Number(process.env.ROUTER_SUPERVISOR_RESTART_MS || 5000);

function log(msg) {
  const t = new Date().toLocaleString('zh-CN', { hour12: false });
  const line = '[' + t + '] ' + msg + '\n';
  try {
    fs.appendFileSync(LOG, line);
  } catch {
    /* 日志写不进去也不能让守护挂掉 */
  }
  try {
    process.stdout.write(line);
  } catch {
    /* 没有控制台时忽略 */
  }
}

// ---------------------------------------------------------------- 单实例互斥
// 用「绑定一个本地端口」当锁：进程一死，系统立刻释放，不存在残留锁文件的问题。
function acquireSingleton(cb) {
  const srv = net.createServer((sock) => {
    sock.end('router-supervisor\n');
  });
  srv.once('error', (err) => {
    if (err.code !== 'EADDRINUSE') {
      log('控制端口监听失败（' + err.code + '），仍然继续守护');
      return cb(true);
    }
    // 端口被占：先确认占着的是不是同类守护，避免误判
    const probe = net.connect({ port: CONTROL_PORT, host: '127.0.0.1' });
    let buf = '';
    const done = (ours) => {
      probe.destroy();
      if (ours) {
        log('已有守护在运行（控制端口 ' + CONTROL_PORT + '），本次退出');
        cb(false);
      } else {
        log('控制端口 ' + CONTROL_PORT + ' 被其他程序占用，本次仍启动（可能出现双守护）');
        cb(true);
      }
    };
    probe.setTimeout(1500, () => done(false));
    probe.on('data', (d) => (buf += d.toString()));
    probe.on('end', () => done(buf.includes('router-supervisor')));
    probe.on('error', () => done(false));
  });
  srv.listen(CONTROL_PORT, '127.0.0.1', () => {
    log('守护启动 pid=' + process.pid + ' 监听 ' + HOST + ':' + PORT + ' 控制端口 ' + CONTROL_PORT);
    cb(true);
  });
  return srv;
}

// ---------------------------------------------------------------- 端口探活
function portBusy() {
  return new Promise((resolve) => {
    const sock = net.connect({ port: PORT, host: HOST });
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(1000, () => finish(false));
    sock.on('connect', () => finish(true));
    sock.on('error', () => finish(false));
  });
}

// ---------------------------------------------------------------- 日志轮转
function rotateIfNeeded() {
  let size = 0;
  try {
    size = fs.statSync(LOG).size;
  } catch {
    return;
  }
  if (size < LOG_MAX) return;
  const bak = LOG + '.1';
  try {
    fs.rmSync(bak, { force: true });
    fs.renameSync(LOG, bak);
    fs.writeFileSync(LOG, '[' + new Date().toLocaleString('zh-CN', { hour12: false }) + '] 日志超过 ' + Math.round(LOG_MAX / 1024 / 1024) + 'MB，已轮转为 ' + path.basename(bak) + '\n');
  } catch (err) {
    log('日志轮转失败：' + err.message);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 健康检查
// 端口在监听 ≠ 服务能用（进程卡死、事件循环被堵住时端口照样 accept）。
// 所以除了探端口，再打一次 /_router/status；连续失败就重启子进程。
function healthOk() {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port: PORT, path: '/_router/status', timeout: 5000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

// ---------------------------------------------------------------- 主循环
let child = null;
let stopping = false;

async function main() {
  const srv = acquireSingleton(async (ok) => {
    if (!ok) process.exit(0);

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    let busyLogged = false;
    while (!stopping) {
      // 端口被别的进程占着（手动起的 node / 另一个没退干净的实例）：等它释放再接管
      if (await portBusy()) {
        if (!busyLogged) {
          log('端口 ' + PORT + ' 已被占用，等它释放后接管');
          busyLogged = true;
        }
        await sleep(CHECK_MS);
        continue;
      }
      if (busyLogged) log('端口 ' + PORT + ' 已释放，接管');
      busyLogged = false;

      rotateIfNeeded();
      const fd = fs.openSync(LOG, 'a');
      log('启动 node router.mjs');
      child = spawn(NODE, ['--env-file=.env', ROUTER], {
        cwd: ROOT,
        stdio: ['ignore', fd, fd],
        windowsHide: true,
      });
      fs.closeSync(fd);
      const startedAt = Date.now();
      let unhealthy = 0;
      const hc = setInterval(async () => {
        if (!child) return;
        if (await healthOk()) {
          unhealthy = 0;
          return;
        }
        unhealthy++;
        log('健康检查失败 ' + unhealthy + '/3');
        if (unhealthy >= 3) {
          unhealthy = 0;
          log('连续 3 次健康检查失败，重启 router');
          try {
            child.kill();
          } catch {
            /* ignore */
          }
        }
      }, CHECK_MS);
      const code = await new Promise((resolve) => child.once('exit', resolve));
      clearInterval(hc);
      child = null;
      if (stopping) break;
      log('router 退出 code=' + code + '（运行 ' + Math.round((Date.now() - startedAt) / 1000) + 's），' + Math.round(RESTART_MS / 1000) + 's 后重启');
      await sleep(RESTART_MS);
    }
  });
  void srv;
}

function shutdown() {
  stopping = true;
  log('收到退出信号，正在关闭 router');
  try {
    child?.kill();
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(0), 1500).unref();
}

// 守护自己出错也不许退出：记一笔继续跑
process.on('uncaughtException', (err) => log('守护未捕获异常（继续）：' + (err?.stack || err)));
process.on('unhandledRejection', (err) => log('守护未处理拒绝（继续）：' + (err?.stack || err)));

main();
