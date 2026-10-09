// Public diagnostics only. Never read cookies, browser profiles or signed media
// URLs; discard each raw response after extracting a small metadata record.
// Usage: node tools/diagnose-videos.mjs VIDEO_ID [VIDEO_ID ...]
import { extractPlayerFacts } from '../src/lib/innertube-parse.js';

const ids = [...new Set(process.argv.slice(2))];
if (!ids.length || ids.some(id => !/^[\w-]{11}$/.test(id))) {
  throw new Error('Pass valid 11-character video identifiers');
}
function playerFromHtml(html) {
  const marker = 'var ytInitialPlayerResponse = ';
  const start = html.indexOf(marker);
  if (start < 0) return null;
  const begin = start + marker.length;
  let depth = 0, quoted = false, escaped = false;
  for (let i = begin; i < html.length; i++) {
    const c = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(html.slice(begin, i + 1));
  }
  return null;
}
async function read(url) {
  try {
    const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(15000) });
    return { status: response.status, body: response.ok ? await response.text() : '' };
  } catch { return { status: 'unreachable', body: '' }; }
}
const feeds = new Map();
async function inspect(id) {
  const page = await read(`https://www.youtube.com/watch?v=${id}&hl=en`);
  const player = playerFromHtml(page.body);
  const facts = extractPlayerFacts(player, id);
  const channelId = player?.videoDetails?.channelId;
  const sources = {};
  if (/^UC[\w-]{22}$/.test(channelId ?? '')) {
    if (!feeds.has(channelId)) feeds.set(channelId, Promise.all(['UULF', 'UULV', 'UUSH'].map(async prefix => {
      const result = await read(`https://www.youtube.com/feeds/videos.xml?playlist_id=${prefix}${channelId.slice(2)}`);
      return [prefix, result];
    })));
    for (const [prefix, result] of await feeds.get(channelId)) {
      sources[prefix] = { status: result.status, present: result.status === 200
        ? result.body.includes(`<yt:videoId>${id}</yt:videoId>`) : null };
    }
  }
  // This is deliberately the whole output schema. In particular, no player
  // response, streamingData, cookie, account identifier or context is printed.
  return { id, status: page.status, title: facts?.title ?? null,
    channelId: channelId ?? null, isShort: facts?.isShort ?? null,
    wasLive: facts?.wasLive ?? null, publishedAt: facts?.publishedAt ?? null,
    durationSec: facts?.durationSec ?? null, sources };
}
const records = [];
let next = 0;
await Promise.all(Array.from({length: Math.min(3, ids.length)}, async () => {
  while (next < ids.length) {
    const id = ids[next++];
    try { records.push(await inspect(id)); }
    catch { records.push({id, status: 'unreadable-metadata'}); }
  }
}));
for (const id of ids) console.log(JSON.stringify(records.find(row => row.id === id)));
