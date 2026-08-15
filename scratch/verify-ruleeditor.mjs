// Screenshots PositionRuleEditor from the standalone preview harness. Never clicks Save,
// so nothing reaches the paper book.
import { chromium } from 'playwright';

const OUT = process.argv[2] || 'rule';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 760 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

const hint = () => page.locator('#rule-exit-time-hint').innerText();
const time = () => page.locator('input[type="time"]').first();

async function shoot(tag) {
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}-${tag}.png` });
}

for (const mode of ['GROUP', 'LEG']) {
  await page.goto(`http://localhost:8000/scratch/rule-editor-preview.html?mode=${mode}`, {
    waitUntil: 'networkidle',
  });
  await page.waitForTimeout(900);

  console.log(`\n===== ${mode} =====`);
  console.log('hint, no time set:', await hint());
  await shoot(`${mode}-off`);

  await time().fill('23:58');
  console.log('hint, future time:', await hint());
  await shoot(`${mode}-future`);

  await time().fill('00:01');
  console.log('hint, past time:', await hint());
  await shoot(`${mode}-past`);

  // Clear must return the field to the off state.
  await page.locator('button:has-text("Clear")').first().click();
  await page.waitForTimeout(200);
  console.log('after Clear — value:', JSON.stringify(await time().inputValue()));
  console.log('after Clear — hint:', await hint());
}

console.log('\nconsole errors:', JSON.stringify(errors.slice(0, 10), null, 2));
await browser.close();
