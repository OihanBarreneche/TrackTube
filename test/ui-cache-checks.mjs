import assert from 'node:assert/strict';

export async function checkUiCache(browser, origin) {
  const context = await browser.newContext({viewport:{width:1280,height:950}});
  const page = await context.newPage(), errors = [], checks = [];
  page.on('pageerror',e => errors.push(e.message));
  const check = (name, value) => { assert.ok(value,name); checks.push(name); };
  try {
    const start = performance.now();
    await page.goto(`${origin}/test/popup-preview.html?cached=1&slowWorker=2500`);
    const popup = page.frameLocator('#popup');
    await popup.locator('#stat-day').getByText('23',{exact:true}).waitFor();
    const cachedPopupMs = Math.round(performance.now()-start);
    check('Cached feed counter appears before the delayed worker', cachedPopupMs < 1500);
    check('Cached publication chart has all seven bars', await popup.locator('#pulse-body .bar-col').count() === 7);
    await popup.locator('[data-mode="history"]').click();
    check('Cached history count is already visible on tab change',
      (await popup.locator('#hist-count').innerText()).replace(/\s/g,'') === '1234');
    check('History highlights do not wait behind sync and triage', await popup.locator('#acc-hist').isVisible());
    await popup.locator('#hist-count').getByText(/9\s?412/).waitFor();
    await popup.locator('[data-mode="feed"]').click();
    await popup.locator('#stat-day').getByText('63',{exact:true}).waitFor();
    check('Fresh worker values replace the cached counts', true);

    await page.goto(`${origin}/test/popup-preview.html?cached=1&failed=1`);
    await page.frameLocator('#popup').locator('#stat-day').getByText('23',{exact:true}).waitFor();
    await page.frameLocator('#popup').locator('[data-mode="history"]').click();
    check('Worker failure preserves the last successful history figures',
      (await page.frameLocator('#popup').locator('#hist-count').innerText()).replace(/\s/g,'') === '1234');

    await page.goto(`${origin}/test/history-preview.html`);
    await page.waitForFunction(() => !!localStorage.getItem('tracktube:historyBench')
      && JSON.parse(localStorage.getItem('tracktube:historyBench'))['ytfeed:uiHistoryStats']?.stats);
    await page.evaluate(() => {
      const data = JSON.parse(localStorage.getItem('tracktube:historyBench'));
      data['ytfeed:uiHistoryStats'].stats.total = 777;
      localStorage.setItem('tracktube:historyBench',JSON.stringify(data));
    });
    const historyStart = performance.now();
    await page.goto(`${origin}/test/history-preview.html?slowWorker=3000`);
    await page.locator('#s-videos').getByText('777',{exact:true}).waitFor();
    const cachedHistoryMs = Math.round(performance.now()-historyStart);
    check('Analysis statistics appear from disk before recomputation', cachedHistoryMs < 1500);
    check('Cached analysis is visible without a blocking loading marker',
      await page.locator('#results').isVisible() && !await page.locator('#loading').isVisible());
    await page.waitForFunction(() => document.querySelector('#s-videos').textContent !== '777', {timeout:15000});
    check('Recomputed analysis replaces the cached statistics', true);
    await page.goto(`${origin}/test/history-preview.html?rangeRace=1`);
    await page.waitForFunction(() => window.historyBench?.responses.length > 0);
    await page.locator('[data-range="30j"]').click();
    await page.locator('[data-range="7j"]').click();
    await page.waitForFunction(() => window.historyBench.responses.some(r=>JSON.parse(r.scope||'[]')[0]==='7j'));
    const current = await page.locator('#s-videos').innerText();
    await page.waitForFunction(() => window.historyBench.responses.some(r=>JSON.parse(r.scope||'[]')[0]==='30j'));
    await page.waitForTimeout(100);
    check('A slow answer for the previous range cannot replace the current figures',
      await page.locator('#s-videos').innerText() === current);
    assert.deepEqual(errors,[]);
    return {path:'ui-cache',result:`${checks.length} contrôles de cache réussis`,
      cachedPopupMs,cachedHistoryMs,workerDelayMs:2500,historyDelayMs:3000,checks,errors};
  } finally { await context.close(); }
}
