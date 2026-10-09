// Public diagnostic: URLs and media bytes stay in RAM, never in reports.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createBenchServer } from './test-server.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.TRACKTUBE_PLAYWRIGHT_PATH || 'playwright');
const id = process.argv[2] || 'rgGelDw8REw';
if (!/^[\w-]{11}$/.test(id)) throw new Error('Invalid video id');
const html = await (await fetch(`https://www.youtube.com/watch?v=${id}`)).text();
const key = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/)?.[1];
const player = await (await fetch(`https://www.youtube.com/youtubei/v1/player?key=${key}&prettyPrint=false`, {
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    context:{client:{clientName:'IOS',clientVersion:'20.10.4',deviceMake:'Apple',deviceModel:'iPhone16,2',
      osName:'iPhone',osVersion:'18.3.2.22D82',hl:'fr',gl:'FR'}},videoId:id,contentCheckOk:true,racyCheckOk:true,
  }),
})).json();
const formats = player.streamingData?.adaptiveFormats || [];
const original = f => !f.audioTrack || (f.xtags && Buffer.from(f.xtags,'base64url').toString('latin1').includes('original'));
const video = formats.find(f => f.itag === 134 && f.url);
const track = f => ({url:f.url,mime:f.mimeType,init:{start:+f.initRange.start,end:+f.initRange.end},
  index:{start:+f.indexRange.start,end:+f.indexRange.end}});
const server = createBenchServer(resolve('.'));
await new Promise(r => server.listen(0,'127.0.0.1',r));
const browser = await chromium.launch({headless:true,executablePath:process.env.TRACKTUBE_BROWSER_PATH});
try {
  for (const itag of [139,140]) {
    const audio = formats.find(f => f.itag === itag && f.url && !f.isDrc && original(f));
    if (!video || !audio) { console.log(JSON.stringify({id,itag,status:player.playabilityStatus?.status,missing:true})); continue; }
    const context = await browser.newContext({viewport:{width:1280,height:950}});
    const page = await context.newPage();
    // All request errors are reduced to HTTP status, never stringify URLs/errors.
    const failures = [];
    const diagnostics = [];
    page.on('console',m => { if(m.text().includes('Preview stream unusable')) diagnostics.push('stream initialization failed'); });
    // Local fixture has a different origin: proxy only these media requests in
    // RAM so CORS cannot masquerade as a decoder failure.
    await page.route('**/*googlevideo.com/**', async route => {
      try {
        const rep = await fetch(route.request().url());
        if (!rep.ok) failures.push(rep.status);
        await route.fulfill({status:rep.status,contentType:rep.headers.get('content-type') || 'application/octet-stream',
          headers:{'Access-Control-Allow-Origin':'*'},body:Buffer.from(await rep.arrayBuffer())});
      } catch { diagnostics.push('media request failed'); await route.abort(); }
    });
    page.on('response',r => { if (r.url().includes('googlevideo.com') && r.status() >= 400) failures.push(r.status()); });
    await page.route('**/test/preview-innertube.js',route => route.fulfill({contentType:'text/javascript',body:
      `export async function fetchMovingThumbnail(){return null;} export async function fetchPreview(){return ${JSON.stringify({
        stream:track(video),audio:track(audio),duration:+player.videoDetails.lengthSeconds,storyboard:null,
      })};} export async function fetchChannelUploads(){return {videos:[]};}`,
    }));
    await page.goto(`http://127.0.0.1:${server.address().port}/test/preview-playback.html`);
    await page.locator('body[data-ready="true"]').waitFor();
    await page.locator('.tracktube-thumb').first().hover();
    const deadline = Date.now()+15000;
    let result;
    do {
      await new Promise(r => setTimeout(r,500));
      result = await page.evaluate(() => {
        const v = window.previewBench.players.at(-1)?.video;
        return {time:v?.currentTime,ready:v?.readyState,audioBytes:v?.webkitAudioDecodedByteCount,
          error:v?.error?.code,attached:v?.isConnected,sound:!!document.querySelector('.tracktube-sound')};
      });
    } while (Date.now()<deadline && !(result?.time>3) && !result?.error);
    console.log(JSON.stringify({id,itag,codec:audio.mimeType,...result,failures,diagnostics}));
    await context.close();
  }
} finally { await browser.close(); await new Promise(r => server.close(r)); }
