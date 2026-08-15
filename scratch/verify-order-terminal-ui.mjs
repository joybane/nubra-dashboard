// Renders the built app against a throwaway server and captures the Orders tab, the inline
// amendment editor and the square-off confirmation at desktop and phone widths.
// Requires a server started with PAPER_DB_PATH pointing at a COPY of paper.db.
import { chromium } from 'playwright';
import path from 'path';

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3099';
const OUT = process.env.SHOT_DIR || path.join(process.cwd(), 'scratch', 'shots');

// A resting order to drive the editor with: an unseen ref_id has no cached tick, so it stays open.
const placed = await fetch(`${BASE}/paper/orders`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    nubraName: 'UISMOKE_CE',
    liveRefId: 987654322,
    display_name: 'UISMOKE 24000 CE',
    order_type: 'ORDER_TYPE_REGULAR',
    order_side: 'ORDER_SIDE_BUY',
    order_qty: 65,
    order_price: 100_00,
    order_delivery_type: 'ORDER_DELIVERY_TYPE_IDAY',
    validity_type: 'DAY',
  }),
}).then((r) => r.json());
console.log('resting order:', placed.order_id);

const browser = await chromium.launch();
const problems = [];

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
  // Horizontal overflow on the document is the classic responsive break.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (overflow > 0) problems.push(`${name}: page scrolls horizontally by ${overflow}px`);
  console.log(`  shot ${name} (h-overflow ${overflow}px)`);
}

for (const [label, width, height] of [
  ['desktop', 1440, 900],
  ['laptop', 1280, 800],
  ['tablet', 834, 1112],
  ['phone', 390, 844],
]) {
  const page = await browser.newPage({ viewport: { width, height } });
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // The terminal starts collapsed; the Orders tab button opens it.
  const ordersTab = page.getByRole('button', { name: /^Orders/ }).first();
  if (await ordersTab.count()) {
    await ordersTab.click();
    await page.waitForTimeout(800);
  }
  await shot(page, `${label}-orders`);

  const modify = page.getByRole('button', { name: 'Modify' }).first();
  if (await modify.count()) {
    await modify.click();
    await page.waitForTimeout(400);
    await shot(page, `${label}-modify-editor`);
    const cancel = page.getByRole('button', { name: 'Cancel' }).first();
    if (await cancel.count()) await cancel.click();
  } else {
    console.log(`  (no Modify button visible at ${label})`);
  }

  // Positions tab -> the square-off confirmation.
  const posTab = page.getByRole('button', { name: /^Positions/ }).first();
  if (await posTab.count()) {
    await posTab.click();
    await page.waitForTimeout(800);
    const exitAll = page.getByRole('button', { name: 'Exit All' }).first();
    if (await exitAll.count()) {
      await exitAll.click();
      await page.waitForTimeout(400);
      await shot(page, `${label}-exit-confirm`);
      const dismiss = page.getByRole('button', { name: 'Cancel' }).first();
      if (await dismiss.count()) await dismiss.click();
    } else {
      console.log(`  (no Exit All button visible at ${label})`);
    }
  }

  if (consoleErrors.length) problems.push(`${label}: console errors -> ${consoleErrors.join(' | ')}`);
  await page.close();
}

await browser.close();

console.log(`\nscreenshots in ${OUT}`);
if (problems.length) {
  console.log('PROBLEMS:');
  for (const p of problems) console.log(' -', p);
  process.exitCode = 1;
} else {
  console.log('No horizontal overflow and no console errors at any width.');
}
