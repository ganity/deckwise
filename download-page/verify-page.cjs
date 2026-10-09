// Run with PLAYWRIGHT_MODULE pointing to an installed Playwright module.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const base = process.argv[2] || 'https://trainwise.efrobot.com/deckwise/';
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const viewport of [{ width: 1440, height: 1050 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
      await page.setViewportSize(viewport);
      await page.goto(base);
      await page.locator('a[data-file][href]').first().waitFor();
      assert.equal(await page.locator('a[data-file][href]').count(), 7);
      assert.equal(await page.locator('[aria-disabled="true"]').count(), 0);
      const links = await page.locator('a[data-file]').evaluateAll(nodes => nodes.map(node => node.href));
      assert(links.every(url => url.startsWith('https://trainwise.oss-cn-beijing.aliyuncs.com/deckwise/')));
      const geometry = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        images: [...document.images].every(img => img.complete && img.naturalWidth > 0),
        clippedButtons: [...document.querySelectorAll('a[data-file]')].some(node => node.scrollWidth > node.clientWidth),
      }));
      assert.equal(geometry.overflow, false);
      assert.equal(geometry.images, true);
      assert.equal(geometry.clippedButtons, false);
      await page.locator('summary').first().click();
      assert.equal(await page.locator('details').first().getAttribute('open'), '');
      await page.screenshot({ path: `/tmp/deckwise-downloads-${viewport.width}.png`, fullPage: true });
    }
    await page.route('**/downloads.json', route => route.fulfill({ status: 503, body: 'unavailable' }));
    await page.goto(base);
    await page.locator('#load-error').waitFor({ state: 'visible' });
    assert.equal(await page.locator('a[data-file][href]').count(), 0);
    await page.unroute('**/downloads.json');
    await page.locator('#retry').click();
    await page.locator('a[data-file][href]').first().waitFor();
    assert.equal(await page.locator('#load-error').isVisible(), false);
    const good = await page.evaluate(async () => (await fetch('./downloads.json')).json());
    good.files['mac-arm64'].name = '../../secret.dmg';
    await page.route('**/downloads.json', route => route.fulfill({ json: good }));
    await page.goto(base);
    await page.locator('#load-error').waitFor({ state: 'visible' });
    assert.equal(await page.locator('a[data-file][href]').count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS: desktop/mobile layouts, seven OSS links, assets, FAQ, retry and invalid manifest');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
