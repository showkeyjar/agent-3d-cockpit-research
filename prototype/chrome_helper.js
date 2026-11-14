// chrome_helper.js — 解析 Playwright Chromium 可执行文件路径
// 消除测试脚本里硬编码的本机绝对路径（C:/Users/.../chromium-1234/chrome.exe），
// 让原型在任意装了 playwright-core + Chromium 的机器上都能跑。
//
// 解析顺序：
//   1) 环境变量 PLAYWRIGHT_CHROMIUM（显式指定，CI / 异机首选）
//   2) $LOCALAPPDATA/ms-playwright 下最新的 chromium-<ver>/chrome-win64/chrome.exe
//   3) 返回 undefined —— 交给 playwright-core 使用其自带浏览器
const fs = require('fs');
const path = require('path');
const os = require('os');

function resolveChromePath() {
  if (process.env.PLAYWRIGHT_CHROMIUM && fs.existsSync(process.env.PLAYWRIGHT_CHROMIUM)) {
    return process.env.PLAYWRIGHT_CHROMIUM;
  }
  const base = process.env.LOCALAPPDATA ||
    (process.platform === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Local')
      : path.join(os.homedir(), '.cache'));
  const dir = path.join(base, 'ms-playwright');
  if (fs.existsSync(dir)) {
    const subs = fs.readdirSync(dir)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort();
    while (subs.length) {
      const cand = path.join(dir, subs.pop(), 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(cand)) return cand;
    }
  }
  return undefined;
}

module.exports = { resolveChromePath };
