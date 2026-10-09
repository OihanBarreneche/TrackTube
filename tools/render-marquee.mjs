import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.TRACKTUBE_PLAYWRIGHT_PATH || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'store-assets');
const lang = process.argv[2] || 'en';
if (!['en', 'fr'].includes(lang)) throw new Error(`Unsupported language: ${lang}`);
const stem = lang === 'en' ? 'marquee' : 'marquee.fr';
let svg = await readFile(path.join(assets, `${stem}.svg`), 'utf8');

for (const name of ['lake', 'road', 'city']) {
  const photo = await readFile(path.join(assets, 'thumbnails', `${name}.jpg`));
  const reference = `href="thumbnails/${name}.jpg"`;
  if (!svg.includes(reference)) throw new Error(`Missing ${reference} in ${stem}.svg`);
  svg = svg.replace(reference, `href="data:image/jpeg;base64,${photo.toString('base64')}"`);
}

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.TRACKTUBE_BROWSER_PATH || undefined,
});

try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 560 }, deviceScaleFactor: 1 });
  await page.goto(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
  await page.locator('svg').screenshot({ path: path.join(assets, `${stem}.png`) });
  await page.close();
} finally {
  await browser.close();
}
