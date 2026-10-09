// Run the browser benches on fresh origins, without using an installed profile.
// Usage: node tools/test.mjs
// Set TRACKTUBE_PLAYWRIGHT_PATH if Playwright is supplied by a shared runtime.
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { checkPreview } from '../test/preview-playback-checks.mjs';
import { checkUiCache } from '../test/ui-cache-checks.mjs';
import { createBenchServer } from './test-server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.TRACKTUBE_PLAYWRIGHT_PATH || 'playwright');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const server = createBenchServer(root);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const reports = [];
try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.TRACKTUBE_BROWSER_PATH ? { executablePath: process.env.TRACKTUBE_BROWSER_PATH } : {}),
  });
  for (const [path, selector] of [['index.html', '#summary.green, #summary.red'], ['modules.html', '#score.ok, #score.ko'], ['history-live.html', '#score.ok, #score.ko'], ['shorts.html', '#summary.green, #summary.red'], ['shorts-view.html', '#summary.green, #summary.red'], ['coverage.html', '#summary.green, #summary.red'], ['collection.html', '#summary.green, #summary.red'], ['watch-tracker.html?v=aaaaaaaaaaa', '#score.ok, #score.ko'], ['ui-snapshot-worker.html','#summary.green, #summary.red']]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    if (path === 'shorts-view.html') {
      // Exercise image failures without depending on YouTube or using a profile.
      await page.route('https://i.ytimg.com/**', async (route) => {
        const url = new URL(route.request().url());
        const failed = url.pathname.endsWith('/expired.jpg') || url.pathname.includes('/vvvvvvvvvv3/');
        await route.fulfill({ status: failed ? 404 : 200,
          headers: { 'Access-Control-Allow-Origin': url.pathname.endsWith('/cors.jpg') ? 'https://www.youtube.com' : '*' },
          contentType: 'image/svg+xml',
          body: failed ? '' : '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="red"/></svg>',
        });
      });
    }
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(`${origin}/test/${path}`);
    await page.waitForSelector(selector, { timeout: 120000 });
    const result = await page.locator(selector).innerText();
    const failures = await page.locator('li.fail, li.ko').allTextContents();
    const timings = await page.locator('li.pass').filter({ hasText: '9000' }).allTextContents();
    const report = { path, result, failures, errors, ...(timings.length ? { timings } : {}) };
    reports.push(report); console.log(JSON.stringify(report));
    if (failures.length || errors.length || await page.locator(selector).evaluate(el => el.matches('.red,.ko'))) process.exitCode = 1;
    await context.close();
  }
  const context = await browser.newContext({viewport:{width:1100,height:850}});
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const start = performance.now();
    await page.goto(`${origin}/test/popup-preview.html?slowCounts=2500`);
    const popup = page.frameLocator('#popup');
    await popup.locator('#pulse-body .bar-col').first().waitFor();
    const chartMs = Math.round(performance.now()-start);
    assert.equal(await popup.locator('#stat-day').innerText(),'—','Chart must not wait for slow counts');
    assert.equal(await popup.locator('#pulse-body .bar-col').count(),7);
    await popup.locator('#btn-settings').click();
    assert.equal(await popup.locator('#mode-feed').evaluate(el=>el.inert),true);
    assert.equal(await popup.locator('#btn-settings-close').evaluate(el=>el===document.activeElement),true);
    await page.keyboard.press('Escape');
    assert.equal(await popup.locator('#settings').isVisible(),false);
    assert.equal(await popup.locator('#btn-settings').evaluate(el=>el===document.activeElement),true);
    await popup.locator('[data-mode="triage"]').click();
    await popup.locator('#triage-done').getByText('128',{exact:true}).waitFor();
    assert.equal(await popup.locator('#triage-left').innerText(),'284');
    assert.equal(await popup.locator('[data-mode="triage"]').getAttribute('aria-pressed'),'true');
    await popup.locator('[data-mode="history"]').click();
    assert.equal(await popup.locator('#set-live-history').isChecked(),false);
    await popup.locator('#acc-hist').waitFor();
    assert.equal((await popup.locator('#acc-hist span').innerText()).includes('acc.hist.'),false);
    await popup.locator('[data-mode="feed"]').click();
    await popup.locator('#stat-day').getByText('63',{exact:true}).waitFor();
    await popup.locator('#btn-settings').click();
    await popup.locator('#set-lang').selectOption('en');
    await popup.locator('[data-mode="history"]').getByText('History',{exact:true}).waitFor({state:'attached'});
    await popup.locator('#set-lang').selectOption('fr');
    await page.keyboard.press('Escape');
    assert.deepEqual(errors,[]);
    const report = {path:'popup-preview.html',result:'14 contrôles UI réussis',chartMs,slowCountsMs:2500,errors};
    reports.push(report); console.log(JSON.stringify(report));
    if (process.env.TRACKTUBE_AUDIT_ARTIFACTS) {
      const output=resolve(process.env.TRACKTUBE_AUDIT_ARTIFACTS);
      await mkdir(output,{recursive:true});
      await page.locator('#popup').screenshot({path:resolve(output,'popup.png')});
    }
  } catch (error) {
    process.exitCode=1;
    const report={path:'popup-preview.html',failures:[error.message],errors};
    reports.push(report);console.log(JSON.stringify(report));
  } finally {await context.close();}
  {
    const context=await browser.newContext({viewport:{width:1280,height:950}});
    const page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    try {
      const output=process.env.TRACKTUBE_AUDIT_ARTIFACTS;
      if(output)await mkdir(resolve(output),{recursive:true});
      const result=await checkPreview(page,origin,output?resolve(output,'preview.png'):null);
      assert.deepEqual(errors,[]);
      const report={path:'preview-playback.html',...result,errors};
      reports.push(report);console.log(JSON.stringify(report));
    } catch(error) {
      process.exitCode=1;
      const report={path:'preview-playback.html',failures:[error.message],errors};
      reports.push(report);console.log(JSON.stringify(report));
    } finally {await context.close();}
  }
  try {
    const report = await checkUiCache(browser,origin);
    reports.push(report); console.log(JSON.stringify(report));
  } catch(error) {
    process.exitCode=1;
    const report={path:'ui-cache',failures:[error.message]};
    reports.push(report);console.log(JSON.stringify(report));
  }
  if (process.env.TRACKTUBE_AUDIT_ARTIFACTS) {
    const output=resolve(process.env.TRACKTUBE_AUDIT_ARTIFACTS);
    await mkdir(output,{recursive:true});
    await writeFile(resolve(output,'tests.json'),JSON.stringify(reports,null,2)+'\n','utf8');
  }
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
}
