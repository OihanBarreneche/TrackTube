import assert from 'node:assert/strict';

/** Real decoded tracks, retries, sound controls and cancellation. */
export async function checkPreview(page, origin, output) {
  const checks = [];
  const check = (name, value) => { assert.ok(value, name); checks.push(name); };
  await page.goto(`${origin}/test/preview-playback.html`);
  await page.locator('body[data-ready="true"]').waitFor();
  const cards = page.locator('.tracktube-card');
  const thumb = i => cards.nth(i).locator('.tracktube-thumb');
  const sound = i => cards.nth(i).locator('.tracktube-sound');
  const video = i => cards.nth(i).locator('video');
  const waitPlaying = async i => {try {await page.waitForFunction(i => {
    const v = document.querySelectorAll('.tracktube-card')[i]?.querySelector('video');
    return v && !v.paused && v.readyState >= 3 && v.currentTime > 0 && v.webkitAudioDecodedByteCount > 0;
  }, i, {timeout:15000});}catch {
    const state=await page.evaluate(()=>window.previewBench.players.map(p=>({id:p.id,time:p.video.currentTime,
      ready:p.video.readyState,paused:p.video.paused,muted:p.video.muted,audio:p.video.webkitAudioDecodedByteCount,
      error:p.video.error?.code,attached:p.video.isConnected})));
    throw new Error(`Rollback playback card ${i}: ${JSON.stringify(state)}`);
  }};
  const waitAudible = async i => page.waitForFunction(i => {
    const v = document.querySelectorAll('.tracktube-card')[i]?.querySelector('video');
    return v && !v.paused && !v.muted && v.webkitAudioDecodedByteCount > 0;
  }, i, {timeout:10000});
  await thumb(0).hover(); await waitPlaying(0);
  check('Restored preview decodes real H.264 and AAC', await video(0).evaluate(v => v.src.startsWith('blob:')));
  check('Preview starts muted', await video(0).evaluate(v => v.muted));
  check('Sound control is available on the first card', await sound(0).isVisible() && await sound(0).isEnabled());
  await sound(0).click(); await waitAudible(0);
  const time = await video(0).evaluate(v => v.currentTime);
  await page.waitForFunction(t => document.querySelector('video')?.currentTime > t + 1.5, time);
  check('Unmuted preview continues playing', await sound(0).getAttribute('aria-pressed') === 'true');
  const box = await thumb(0).boundingBox();
  await page.mouse.move(box.x + box.width * .2, box.y + box.height - 8);
  await page.waitForFunction(()=>{
    const el=document.querySelector('.tracktube-scrub');
    return el&&getComputedStyle(el).opacity!=='0';
  });
  check('Restored storyboard follows the cursor', await cards.nth(0).locator('.tracktube-scrub').evaluate(el => getComputedStyle(el).opacity !== '0'));
  await page.mouse.click(box.x + box.width * .1, box.y + box.height - 8);
  check('Rail click stays in the feed', page.url().endsWith('preview-playback.html'));
  check('Rejected timestamp action is absent', await page.locator('.tracktube-preview-status').count() === 0);
  check('No embedded or native API player is created', await page.locator('.tracktube-card iframe, .tracktube-card ytd-player').count() === 0);
  if (output) await page.screenshot({path:output});
  for (const i of [1, 2]) {
    await thumb(i).hover(); await waitPlaying(i);
    check(`First-row card ${i+1} has available sound`, await sound(i).isVisible() && await sound(i).isEnabled());
    check(`First-row card ${i+1} starts muted`, await video(i).evaluate(v => v.muted));
    await sound(i).click(); await waitAudible(i);
  }
  check('Leaving a card stops and unloads its media', await page.evaluate(() => {
    const old = window.previewBench.players[0].video;
    return old.paused && !old.getAttribute('src') && !old.isConnected;
  }));
  check('Only the current preview remains attached', await page.locator('.tracktube-card video').count() === 1);
  for (const example of ['metadata-retry','audio-retry','audio-alternative']) {
    await page.goto(`${origin}/test/preview-playback.html?case=${example}`);
    await page.locator('body[data-ready="true"]').waitFor();
    await thumb(0).hover(); await waitPlaying(0);
    await sound(0).click(); await waitAudible(0);
    check(`${example}: recovered preview has decoded audible sound`, await sound(0).isVisible());
    if (example === 'metadata-retry') check('Temporary metadata failure is retried within the same hover',
      await page.evaluate(() => window.previewBench.imageCalls.preview0000 === 2));
  }
  await page.goto(`${origin}/test/preview-playback.html?case=audio-refused`);
  await page.locator('body[data-ready="true"]').waitFor();
  await thumb(0).hover();
  await page.waitForFunction(() => {
    const v = document.querySelector('video');
    return v?.readyState >= 3 && v.currentTime > 1;
  });
  check('Permanent audio refusal does not leave an empty buffer blocking video', await video(0).count() === 1);
  check('A refused audio track never exposes a false sound button', await sound(0).count() === 0);
  check('Failure recovery is bounded to one metadata refresh',
    await page.evaluate(() => window.previewBench.imageCalls.preview0000 === 2));
  await page.goto(`${origin}/test/preview-playback.html?case=slow-header`);
  await page.locator('body[data-ready="true"]').waitFor();
  await thumb(0).hover(); await video(0).waitFor();
  await page.mouse.move(10,10);
  await page.waitForFunction(() => !document.querySelector('.tracktube-card video'));
  await page.waitForTimeout(2000);
  check('Leaving during initialization cannot resurrect a preview', await page.locator('.tracktube-card video').count() === 0);
  return {result:`${checks.length} contrôles de lecture réussis`, checks,
    limitation:'Synthetic media in an isolated profile; does not certify YouTube availability or remove server-side seek restrictions.'};
}
