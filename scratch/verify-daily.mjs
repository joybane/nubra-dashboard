// 1d / 1w / 1mt bars carry {year,month,day} rather than epoch seconds. Reading one as a number
// produced "NaN NaN NaN:NaN" in the tooltip header; this proves the header on each of them.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

await page.goto('http://localhost:8000/', { waitUntil: 'networkidle' });
await page.waitForTimeout(6000);

const pane = page.locator('div.relative.flex-1').first();

for (const iv of ['1d', '1w', '1mt', '5m']) {
  await page.locator(`button:text-is("${iv}")`).first().click();
  await page.waitForTimeout(4000);
  const box = await pane.boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.35);
  await page.waitForTimeout(300);
  await page.mouse.move(box.x + box.width * 0.51, box.y + box.height * 0.35);
  await page.waitForTimeout(500);
  const header = await page.evaluate(() => {
    for (const el of document.querySelectorAll('div')) {
      const cls = String(el.className || '');
      if (cls.includes('z-30') && cls.includes('shadow-2xl')) {
        return getComputedStyle(el).display === 'none' ? '(hidden)' : el.innerText.split('\n')[1];
      }
    }
    return '(no card)';
  });
  console.log(`${iv.padEnd(4)} header time -> ${header}`);
}

console.log('console errors:', JSON.stringify(errors.slice(0, 10), null, 2));
await browser.close();
