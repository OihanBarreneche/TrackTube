// Synthetic track metadata only. The restored production reader handles SIDX.
export async function fetchMovingThumbnail() { return '/test/fixtures/preview-sheet.svg'; }
async function track(kind) {
  const url = `/test/fixtures/preview-${kind}.mp4`;
  const bytes = await (await fetch(url)).arrayBuffer(), d = new DataView(bytes);
  let start = 0;
  while (start + 8 < bytes.byteLength && d.getUint32(start + 4) !== 0x73696478) start += d.getUint32(start);
  const index = { start, end:start + d.getUint32(start) - 1 };
  let mime = 'audio/mp4; codecs="mp4a.40.2"';
  if (kind === 'video') {
    const b = new Uint8Array(bytes);
    const at = b.findIndex((v, i) => v === 97 && b[i+1] === 118 && b[i+2] === 99 && b[i+3] === 67);
    const codec = [b[at+5], b[at+6], b[at+7]].map(n => n.toString(16).padStart(2, '0')).join('');
    mime = `video/mp4; codecs="avc1.${codec}"`;
  }
  // Legacy reader appends '&range=' to an already queried media address.
  return { url:location.origin + url + '?fixture=legacy', mime, init:{ start:0, end:start-1 }, index };
}
const fixture = Promise.all([track('video'), track('audio')]);
export async function fetchPreview(id, minHeight = 360) {
  window.previewBench.imageCalls[id] = (window.previewBench.imageCalls[id] || 0) + 1;
  await new Promise(r => setTimeout(r, window.previewBench.metadataDelay));
  const [baseStream, baseAudio] = await fixture;
  const params = new URL(location.href).searchParams;
  const example = params.get('case');
  if (example === 'metadata-retry' && window.previewBench.imageCalls[id] === 1) return null;
  const stream = { ...baseStream }, audio = { ...baseAudio };
  if (example) { stream.url += '&case=' + example; audio.url += '&case=' + example; }
  const alternative = { ...baseAudio, url: baseAudio.url + '&alternative=1' };
  return { duration:40, stream, audio, audios: example === 'audio-alternative' ? [audio, alternative] : [audio], storyboard:{ count:8, columns:1, rows:1,
    intervalMs:5000, urls:Array(8).fill('/test/fixtures/preview-sheet.svg') } };
}
export async function fetchChannelUploads() { return { videos: [] }; }
