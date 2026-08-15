import { chromium } from 'playwright';

const OUT = process.argv[2] || 'shot';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

await page.goto('http://localhost:8000/', { waitUntil: 'networkidle' });
await page.waitForTimeout(6000);

// Switch the greek overlays on — they render into sub-panes below the price on this view,
// which is the case the tooltip's multi-pane row gathering exists for.
for (const label of ['Vega', 'Theta', 'IV']) {
  const btn = page.locator(`button:has-text("${label}")`).first();
  if (await btn.count()) {
    await btn.click();
    await page.waitForTimeout(1500);
  }
}
await page.waitForTimeout(12000); // greek history is reconstructed, not fetched ready-made

const pane = page.locator('div.relative.flex-1').first();
const box = await pane.boundingBox();
console.log('pane box:', JSON.stringify(box));

async function hoverAt(fx, fy, tag) {
  await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
  await page.waitForTimeout(300);
  await page.mouse.move(box.x + box.width * (fx + 0.01), box.y + box.height * fy);
  await page.waitForTimeout(500);
  const card = await page.evaluate(() => {
    for (const el of document.querySelectorAll('div')) {
      const cls = String(el.className || '');
      if (!cls.includes('z-30') || !cls.includes('shadow-2xl')) continue;
      if (getComputedStyle(el).display === 'none') return null;
      const r = el.getBoundingClientRect();
      return { text: el.innerText.trim(), left: Math.round(r.left), top: Math.round(r.top) };
    }
    return null;
  });
  console.log(`--- hover ${tag}:`, JSON.stringify(card, null, 2));
  await page.screenshot({ path: `${OUT}-${tag}.png` });
}

await hoverAt(0.55, 0.2, 'price-pane');
await hoverAt(0.55, 0.72, 'greek-pane');

// Leaving the chart must take the card with it.
await page.mouse.move(10, 10);
await page.waitForTimeout(400);
const afterLeave = await page.evaluate(() => {
  for (const el of document.querySelectorAll('div')) {
    const cls = String(el.className || '');
    if (cls.includes('z-30') && cls.includes('shadow-2xl')) return getComputedStyle(el).display;
  }
  return 'not-found';
});
console.log('display after mouseleave:', afterLeave);
console.log('console errors:', JSON.stringify(errors.slice(0, 10), null, 2));
await browser.close();
