'use strict';
/** 手机端批量检查所有页面。 */
const puppeteer = require('puppeteer-core');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PAGES = [
  { hash: '#/dashboard', name: '概览' },
  { hash: '#/tasks', name: '任务' },
  { hash: '#/new', name: '新建任务' },
  { hash: '#/tasks/8', name: '任务详情' },
  { hash: '#/storage', name: '存储' },
  { hash: '#/users', name: '用户' },
  { hash: '#/settings', name: '设置' },
];

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox'],
    defaultViewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  });
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
  );

  await page.goto('http://127.0.0.1:8080', { waitUntil: 'networkidle2' });
  await page.type('input[type=text]', 'admin');
  await page.type('input[type=password]', 'admin123');
  await Promise.all([page.waitForSelector('.sidebar', { timeout: 15000 }), page.click('button[type=submit]')]);

  for (const p of PAGES) {
    await page.goto(`http://127.0.0.1:8080/${p.hash}`, { waitUntil: 'networkidle2' });
    await new Promise((r) => setTimeout(r, 1800));

    const info = await page.evaluate(() => {
      const vw = window.innerWidth;
      // 找出超出视口宽度的元素
      const offenders = [];
      document.querySelectorAll('*').forEach((el) => {
        const b = el.getBoundingClientRect();
        if (b.width > 0 && (b.right > vw + 2 || b.left < -2)) {
          const cls = (el.className || '').toString().split(' ')[0];
          if (offenders.length < 5) {
            offenders.push(`${el.tagName.toLowerCase()}.${cls} → right=${Math.round(b.right)} left=${Math.round(b.left)}`);
          }
        }
      });
      return {
        scrollW: document.documentElement.scrollWidth,
        vw,
        overflow: document.documentElement.scrollWidth > vw + 1,
        offenders,
      };
    });

    const mark = info.overflow ? '✗ 横向溢出' : '✓';
    console.log(`${p.name.padEnd(6)} ${mark}  scrollW=${info.scrollW}`);
    if (info.offenders.length) {
      for (const o of info.offenders) console.log(`         ${o}`);
    }

    await page.screenshot({ path: `screenshots/m-${p.name}.png` });
  }

  await browser.close();
})();
