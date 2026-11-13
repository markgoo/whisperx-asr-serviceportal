'use strict';
/** 手机视口截图任务详情页，找出布局问题。 */
const puppeteer = require('puppeteer-core');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const TASK = process.argv[2] || '8';
const WIDTH = Number(process.argv[3] || 390);
const HEIGHT = Number(process.argv[4] || 844);

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox'],
    defaultViewport: { width: WIDTH, height: HEIGHT, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  });
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  );

  await page.goto('http://127.0.0.1:8080', { waitUntil: 'networkidle2' });
  await page.type('input[type=text]', 'admin');
  await page.type('input[type=password]', 'admin123');
  await Promise.all([page.waitForSelector('.sidebar', { timeout: 15000 }), page.click('button[type=submit]')]);
  await page.goto(`http://127.0.0.1:8080/#/tasks/${TASK}`, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 2500));

  await page.screenshot({ path: `screenshots/mobile-detail-${WIDTH}.png`, fullPage: false });
  await page.screenshot({ path: `screenshots/mobile-detail-${WIDTH}-full.png`, fullPage: true });

  const info = await page.evaluate(() => {
    const r = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height), left: Math.round(b.left) };
    };
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      docScrollW: document.documentElement.scrollWidth,
      sidebar: r('.sidebar'),
      app: r('.app'),
      player: r('.player-top'),
      layout: r('.detail-layout'),
      firstCard: r('.detail-layout > .card'),
      side: r('.detail-side'),
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})();
