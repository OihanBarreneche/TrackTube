import assert from 'node:assert/strict';
import { fetchUploadsDirect, parsePublicWebConfig } from '../src/background/innertube-direct.js';

const fakeKey = 'local_test_key_0123456789012345';
const html = `<script>ytcfg.set({"INNERTUBE_API_KEY":"${fakeKey}","INNERTUBE_CLIENT_VERSION":"2.20261008.01.00"});</script>`;
assert.equal(parsePublicWebConfig('no YouTube configuration'), null);
assert.equal(parsePublicWebConfig(html)?.key, fakeKey);
assert.equal(parsePublicWebConfig(html)?.context.client.clientVersion, '2.20261008.01.00');

const originalFetch = globalThis.fetch;
const requests = [];
try {
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return String(url).endsWith('/')
      ? new Response(html)
      : new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  };
  const channelId = `UC${'a'.repeat(22)}`;
  const results = await Promise.all([
    fetchUploadsDirect(channelId), fetchUploadsDirect(channelId),
  ]);
  assert.ok(results.every((result) => Array.isArray(result?.videos)));
  const configRequests = requests.filter(({ url }) => url === 'https://www.youtube.com/');
  const browseRequests = requests.filter(({ url }) => url.includes('/youtubei/v1/browse'));
  assert.equal(configRequests.length, 1, 'concurrent calls reuse one configuration fetch');
  assert.equal(browseRequests.length, 2);
  assert.equal(configRequests[0].options.credentials, 'omit');
  for (const { url, options } of browseRequests) {
    assert.equal(new URL(url).searchParams.get('key'), fakeKey);
    assert.equal(options.credentials, 'omit');
    assert.equal(JSON.parse(options.body).context.client.clientVersion, '2.20261008.01.00');
  }
} finally {
  globalThis.fetch = originalFetch;
}
console.log('Anonymous InnerTube configuration checks passed');
