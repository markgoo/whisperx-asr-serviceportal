/**
 * 用无头 Edge/Chrome 走一遍真实界面，截图并检查控制台错误。
 *
 * 用法：node tools/ui-check.js [baseUrl]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const OUT = path.join(__dirname, '..', 'screenshots');

const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function findBrowser() {
  for (const p of CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('找不到 Edge/Chrome');
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,1000'],
    defaultViewport: { width: 1440, height: 1000 },
  });

  const page = await browser.newPage();
  const errors = [];
  // 未登录时 /api/auth/me 返回 401 是正常的会话探测，不算错误。
  const IGNORED = [/status of 401/];
  const ignorable = (text) => IGNORED.some((re) => re.test(text));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !ignorable(msg.text())) errors.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) => {
    const text = `${req.url()} ${req.failure()?.errorText}`;
    if (!ignorable(text)) errors.push(`requestfailed: ${text}`);
  });

  const shots = [];
  async function shot(name) {
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file, fullPage: false });
    shots.push(name);
    console.log(`  · 截图 ${name}.png`);
  }

  console.log('\n== 界面检查 ==\n');

  // 1. 登录页
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForSelector('input[type="password"]', { timeout: 8000 });
  console.log('[1] 登录页渲染');
  await shot('01-login');

  // 2. 登录
  console.log('[2] 登录');
  await page.type('input[type="text"]', 'admin');
  await page.type('input[type="password"]', 'admin123');
  await Promise.all([
    page.waitForFunction(() => !!document.querySelector('.sidebar'), { timeout: 10000 }),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForSelector('.sidebar', { timeout: 8000 });
  await new Promise((r) => setTimeout(r, 800));
  await shot('02-dashboard');
  console.log('  ✓ 已进入主界面');

  // 3. 新建任务页
  console.log('[3] 新建任务页（说话人分离默认勾选）');
  await page.goto(`${BASE}/#/new`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.dropzone', { timeout: 8000 });
  const diarizeChecked = await page.$eval(
    '.switch input[type="checkbox"]',
    (el) => el.checked,
  );
  console.log(`  · 说话人分离默认勾选: ${diarizeChecked}`);
  if (!diarizeChecked) errors.push('说话人分离默认未勾选');
  await shot('03-new-task');

  // 4. 真实上传一个 wav
  console.log('[4] 上传文件并转写');
  const wavPath = path.join(OUT, 'sample.wav');
  fs.writeFileSync(wavPath, makeWav(2));
  await page.type('input[placeholder*="产品周会"]', '界面测试任务');
  const fileInput = await page.$('input[type="file"]');
  await fileInput.uploadFile(wavPath);
  await new Promise((r) => setTimeout(r, 400));
  await shot('04-file-selected');
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => location.hash.startsWith('#/tasks/'), { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 1200));
  await shot('05-task-running');
  console.log('  ✓ 已跳转到任务详情');

  // 5. 等待完成
  console.log('[5] 等待转写完成');
  await page.waitForFunction(
    () => !!document.querySelector('.tabs button'),
    { timeout: 60000, polling: 800 },
  );
  await new Promise((r) => setTimeout(r, 700));
  await shot('06-task-completed');
  const speakerPills = await page.$$eval('.chip-row .badge-pill', (els) => els.length);
  console.log(`  · 说话人标签数: ${speakerPills}`);
  if (speakerPills < 2) errors.push(`说话人标签过少: ${speakerPills}`);

  // 6. 其他页面
  for (const [hash, name, sel] of [
    ['/tasks', '07-tasks', '.table'],
    ['/storage', '08-storage', '.stat'],
    ['/users', '09-users', '.table'],
    ['/settings', '10-settings', '.card'],
    ['/account', '11-account', 'form'],
  ]) {
    console.log(`[6] 页面 ${hash}`);
    await page.goto(`${BASE}/#${hash}`, { waitUntil: 'networkidle2' });
    try {
      await page.waitForSelector(sel, { timeout: 8000 });
    } catch {
      errors.push(`页面 ${hash} 未渲染出 ${sel}`);
    }
    await new Promise((r) => setTimeout(r, 600));
    await shot(name);
  }

  // 7. 移动端视图
  console.log('[7] 窄屏视图');
  await page.setViewport({ width: 420, height: 860 });
  await page.goto(`${BASE}/#/dashboard`, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 700));
  await shot('12-mobile');

  await browser.close();

  console.log(`\n== 结果 ==`);
  if (errors.length) {
    console.log(`${errors.length} 个问题：`);
    for (const e of errors) console.log(`  ✗ ${e}`);
    process.exit(1);
  }
  console.log(`全部通过 ✓ （${shots.length} 张截图在 screenshots/）\n`);
}

function makeWav(seconds) {
  const sampleRate = 8000;
  const samples = sampleRate * seconds;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i += 1) {
    buf.writeInt16LE(Math.round(Math.sin((i / sampleRate) * 440 * 2 * Math.PI) * 8000), 44 + i * 2);
  }
  return buf;
}

main().catch((err) => {
  console.error('界面检查异常：', err);
  process.exit(1);
});
