'use strict';
/**
 * 验证：改名后播放位置和滚动位置不被重置。
 * 这是之前的一个 bug —— 改名会触发整页重渲染，音频跳回 0:00。
 */
const puppeteer = require('puppeteer-core');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const TASK = process.argv[2] || '22';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
    defaultViewport: { width: 1440, height: 1000 },
  });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  await page.goto('http://127.0.0.1:8080', { waitUntil: 'networkidle2' });
  await page.type('input[type=text]', '__tmp_verify');
  await page.type('input[type=password]', 'tmp-verify-2026');
  await Promise.all([page.waitForSelector('.sidebar'), page.click('button[type=submit]')]);
  await page.goto(`http://127.0.0.1:8080/#/tasks/${TASK}`, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 2500));

  // 1. 把播放位置拖到中间（约 40%）
  await page.evaluate(() => {
    const a = document.querySelector('audio');
    a.currentTime = a.duration ? a.duration * 0.4 : 200;
    a.dispatchEvent(new Event('timeupdate'));
  });
  await new Promise((r) => setTimeout(r, 800));

  const before = await page.evaluate(() => {
    const a = document.querySelector('audio');
    const list = document.querySelector('.transcript');
    return {
      currentTime: +a.currentTime.toFixed(1),
      audioElementId: a.dataset.probe || (a.dataset.probe = String(Math.random())),
      scrollTop: list ? Math.round(list.scrollTop) : 0,
      firstChip: (document.querySelectorAll('.chip')[1] || {}).textContent?.trim() || '',
    };
  });

  // 2. 点第一个说话人的铅笔改名
  const chips = await page.$$('.chip');
  const pen = await chips[1].evaluateHandle((el) => el.querySelectorAll('.chip-act')[0]);
  await pen.asElement().click();
  await new Promise((r) => setTimeout(r, 700));

  await page.$eval('.modal input[type=text]', (el) => { el.value = ''; });
  const input = await page.$('.modal input[type=text]');
  await input.click();
  await input.type('主持人A');
  // 点保存
  const btns = await page.$$('.modal-foot .btn');
  for (const b of btns) {
    const t = await b.evaluate((e) => e.textContent.trim());
    if (t === '保存') { await b.click(); break; }
  }
  await new Promise((r) => setTimeout(r, 1500));

  const after = await page.evaluate(() => {
    const a = document.querySelector('audio');
    const list = document.querySelector('.transcript');
    return {
      currentTime: +a.currentTime.toFixed(1),
      audioElementId: a.dataset.probe || '',
      scrollTop: list ? Math.round(list.scrollTop) : 0,
      firstChip: (document.querySelectorAll('.chip')[1] || {}).textContent?.trim() || '',
      hasNewName: document.body.textContent.includes('主持人A'),
    };
  });

  const ok = Math.abs(after.currentTime - before.currentTime) < 2;
  console.log(JSON.stringify({
    before,
    after,
    playbackPreserved: ok,
    sameAudioElement: before.audioElementId === after.audioElementId,
    nameApplied: after.hasNewName,
    errors: errs,
  }, null, 2));

  // 改名后还原，避免污染数据
  if (after.hasNewName) {
    const c2 = await page.$$('.chip');
    const p2 = await c2[1].evaluateHandle((el) => el.querySelectorAll('.chip-act')[0]);
    await p2.asElement().click();
    await new Promise((r) => setTimeout(r, 600));
    await page.$eval('.modal input[type=text]', (el) => { el.value = ''; });
    const b2 = await page.$$('.modal-foot .btn');
    for (const b of b2) {
      const t = await b.evaluate((e) => e.textContent.trim());
      if (t === '保存') { await b.click(); break; }
    }
    await new Promise((r) => setTimeout(r, 800));
  }

  await browser.close();
  process.exit(ok ? 0 : 1);
})();
