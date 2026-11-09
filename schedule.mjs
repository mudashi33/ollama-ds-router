#!/usr/bin/env node
/**
 * schedule.mjs —— 按北京时间决定该用哪家 API
 *
 * 规则（一句话）：工作日 09:00–12:00、14:00–18:00（北京时间）用 Ollama，
 *                其余所有时间用 DeepSeek 官方。
 *
 * 依据：
 *   DeepSeek 官方高峰 = 北京时间 周一~周五 09:00–12:00、14:00–18:00（节假日除外）
 *   Ollama  高峰 = 工作日 12:00–18:00 UTC = 北京时间 20:00–次日 02:00
 *   两家高峰互不重叠，且同档位价格只差约 6%。
 *   于是：DeepSeek 高峰时段正好是 Ollama 空闲（半价）→ 用 Ollama，省约 47%。
 *
 * 用法：
 *   node schedule.mjs                 打印未来 48 小时的切换点
 *   node schedule.mjs --at <ISO时间>   打印某一时刻的选择
 *   node schedule.mjs --test          跑边界用例自检
 */

import { pathToFileURL } from 'node:url';

const BJ_OFFSET_MS = 8 * 60 * 60 * 1000;

// DeepSeek 高峰窗口（北京时间，分钟为单位，左闭右开）
export const DEEPSEEK_PEAK_BJ = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
];

// Ollama 高峰窗口（UTC，分钟，左闭右开）：工作日 12:00–18:00 UTC
export const OLLAMA_PEAK_UTC = [[12 * 60, 18 * 60]];

// 中国法定节假日（北京日期 YYYY-MM-DD）：这些天 DeepSeek 官方全天空闲
let HOLIDAYS = new Set();

/** 用一组 YYYY-MM-DD（北京时间）覆盖节假日表 */
export function setHolidays(list) {
  HOLIDAYS = new Set(list);
}

export function getHolidays() {
  return [...HOLIDAYS].sort();
}

/** 北京日期键，如 2026-11-06 */
export function beijingDateKey(date) {
  const d = new Date(date.getTime() + BJ_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

const inWindows = (minutes, windows) => windows.some(([a, b]) => minutes >= a && minutes < b);

/** 把绝对时间拆成"北京时间"的星期与分钟数 */
export function beijingParts(date) {
  const d = new Date(date.getTime() + BJ_OFFSET_MS);
  return {
    weekday: d.getUTCDay(), // 0=周日
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    hours: d.getUTCHours(),
    mins: d.getUTCMinutes(),
  };
}

function utcParts(date) {
  return { weekday: date.getUTCDay(), minutes: date.getUTCHours() * 60 + date.getUTCMinutes() };
}

export function isDeepSeekPeak(date) {
  if (HOLIDAYS.has(beijingDateKey(date))) return false; // 法定节假日全天空闲
  const bj = beijingParts(date);
  const weekday = bj.weekday >= 1 && bj.weekday <= 5;
  return weekday && inWindows(bj.minutes, DEEPSEEK_PEAK_BJ);
}

export function isOllamaPeak(date) {
  const u = utcParts(date);
  const weekday = u.weekday >= 1 && u.weekday <= 5;
  return weekday && inWindows(u.minutes, OLLAMA_PEAK_UTC);
}

/**
 * 返回该时刻应该用的上游。
 * @param {Date} date 判断的时刻
 * @param {{preferIdle?: 'deepseek'|'ollama'}} [opts] preferIdle = 两家都空闲时优先哪家（默认 deepseek）
 * @returns {{provider: 'ollama'|'deepseek', reason: string, deepseekPeak: boolean, ollamaPeak: boolean}}
 */
export function pickProvider(date = new Date(), opts = {}) {
  const preferIdle = opts.preferIdle === 'ollama' ? 'ollama' : 'deepseek';
  const dsPeak = isDeepSeekPeak(date);
  const olPeak = isOllamaPeak(date);

  if (dsPeak && !olPeak) {
    return { provider: 'ollama', reason: 'DeepSeek 高峰 + Ollama 空闲（半价）', deepseekPeak: dsPeak, ollamaPeak: olPeak };
  }
  if (olPeak && !dsPeak) {
    return { provider: 'deepseek', reason: 'Ollama 高峰 + DeepSeek 空闲（半价）', deepseekPeak: dsPeak, ollamaPeak: olPeak };
  }
  if (dsPeak && olPeak) {
    // 理论上不会发生（两家高峰不重叠），退化为官方
    return { provider: 'deepseek', reason: '两家同时高峰（异常），退回官方', deepseekPeak: dsPeak, ollamaPeak: olPeak };
  }
  if (preferIdle === 'ollama') {
    return { provider: 'ollama', reason: '两家都空闲，当前模式优先 Ollama', deepseekPeak: dsPeak, ollamaPeak: olPeak };
  }
  return { provider: 'deepseek', reason: '两家都空闲，官方更便宜且原生', deepseekPeak: dsPeak, ollamaPeak: olPeak };
}

const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad = (n) => String(n).padStart(2, '0');

function fmtBeijing(date) {
  const bj = beijingParts(date);
  return `${WEEKDAY_CN[bj.weekday]} ${pad(bj.hours)}:${pad(bj.mins)}`;
}

function fmtUtc(date) {
  return `UTC ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

/** 扫描未来 hours 小时，找出 provider 发生变化的时刻（opts 透传给 pickProvider，用于模式差异） */
export function transitions(from = new Date(), hours = 48, opts = {}) {
  const out = [];
  const start = new Date(Math.floor(from.getTime() / 60000) * 60000);
  let prev = pickProvider(start, opts).provider;
  out.push({ at: start, provider: prev, changed: true });
  for (let m = 1; m <= hours * 60; m++) {
    const t = new Date(start.getTime() + m * 60000);
    const cur = pickProvider(t, opts).provider;
    if (cur !== prev) {
      out.push({ at: t, provider: cur, changed: true });
      prev = cur;
    }
  }
  return out;
}

// ---------------------------------------------------------------- CLI

function printTransitions(hours = 48) {
  const now = new Date();
  const list = transitions(now, hours);
  console.log(`当前：${fmtBeijing(now)}（${fmtUtc(now)}）→ ${pickProvider(now).provider}  — ${pickProvider(now).reason}\n`);
  console.log(`未来 ${hours} 小时的切换点：`);
  for (const t of list) {
    const p = pickProvider(t.at);
    console.log(
      `  ${fmtBeijing(t.at).padEnd(12)} ${fmtUtc(t.at).padEnd(11)} → ${t.provider.padEnd(8)} ${p.reason}`,
    );
  }
}

function printAt(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    console.error(`无法解析时间：${iso}`);
    process.exit(2);
  }
  const p = pickProvider(d);
  console.log(`${fmtBeijing(d)}（${fmtUtc(d)}）→ ${p.provider}`);
  console.log(`  DeepSeek 高峰=${p.deepseekPeak}  Ollama 高峰=${p.ollamaPeak}`);
  console.log(`  ${p.reason}`);
}

function runTests() {
  const cases = [
    ['2026-11-06T08:59:00+08:00', 'deepseek', '周五 08:59 边界前'],
    ['2026-11-06T09:00:00+08:00', 'ollama', '周五 09:00 进入 Ollama 窗口'],
    ['2026-11-06T11:59:00+08:00', 'ollama', '周五 11:59 仍在窗口'],
    ['2026-11-06T12:00:00+08:00', 'deepseek', '周五 12:00 离开窗口'],
    ['2026-11-06T13:59:00+08:00', 'deepseek', '周五 13:59 午休'],
    ['2026-11-06T14:00:00+08:00', 'ollama', '周五 14:00 进入窗口'],
    ['2026-11-06T17:59:00+08:00', 'ollama', '周五 17:59 仍在窗口'],
    ['2026-11-06T18:00:00+08:00', 'deepseek', '周五 18:00 离开窗口'],
    ['2026-11-06T21:00:00+08:00', 'deepseek', '周五 21:00 Ollama 高峰'],
    ['2026-11-07T10:00:00+08:00', 'deepseek', '周六全天用官方'],
    ['2026-11-08T15:00:00+08:00', 'deepseek', '周日全天用官方'],
    ['2026-11-09T01:00:00+08:00', 'deepseek', '周一凌晨（Ollama 仍高峰）'],
    ['2026-11-09T09:00:00+08:00', 'ollama', '周一 09:00 进入窗口'],
  ];

  let pass = 0;
  for (const [iso, want, label] of cases) {
    const got = pickProvider(new Date(iso)).provider;
    const ok = got === want;
    if (ok) pass++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${iso}  want=${want.padEnd(8)} got=${got.padEnd(8)}  ${label}`);
  }
  console.log(`\n${pass}/${cases.length} 个边界用例通过`);

  // 节假日：本该走 Ollama 的周五上午，若被设为法定节假日，应退回官方
  setHolidays(['2026-11-06']);
  const holGot = pickProvider(new Date('2026-11-06T10:00:00+08:00')).provider;
  setHolidays([]);
  const holOk = holGot === 'deepseek';
  console.log(`${holOk ? 'PASS' : 'FAIL'}  2026-11-06T10:00（设为节假日）  want=deepseek  got=${holGot}`);
  console.log(`\n节假日用例 ${holOk ? '通过' : '未通过'}`);
  process.exit(pass === cases.length && holOk ? 0 : 1);
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--test')) runTests();
  else if (args.includes('--at')) printAt(args[args.indexOf('--at') + 1]);
  else printTransitions(48);
}
