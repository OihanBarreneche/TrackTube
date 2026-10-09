// Local fixture only, in a fresh isolated browser; no installed profile/account.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createBenchServer } from './test-server.mjs';
import { checkPreview } from '../test/preview-playback-checks.mjs';

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.TRACKTUBE_PLAYWRIGHT_PATH||'playwright');
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const server=createBenchServer(root);
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;
try {
  browser=await chromium.launch({headless:true,
    ...(process.env.TRACKTUBE_BROWSER_PATH?{executablePath:process.env.TRACKTUBE_BROWSER_PATH}:{})});
  const context=await browser.newContext({viewport:{width:1280,height:950}});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const output=process.env.TRACKTUBE_AUDIT_ARTIFACTS;
  if(output)await mkdir(resolve(output),{recursive:true});
  const report={browser:browser.version(),userAgent:await page.evaluate(()=>navigator.userAgent),
    ...await checkPreview(page,`http://127.0.0.1:${server.address().port}`,output?resolve(output,'preview.png'):null),errors};
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify(report));
  if(output)await writeFile(resolve(output,'preview-tests.json'),JSON.stringify(report,null,2)+'\n');
} finally {
  await browser?.close();await new Promise(r=>server.close(r));
}
