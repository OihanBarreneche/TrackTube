export async function innertubeAvailable() { return true; }
export async function fetchChannelUploads(channelId, options) {
  return globalThis.shortViewBench.uploads(channelId, options);
}
export async function listChannelUploads(channelId, options) {
  return (await fetchChannelUploads(channelId, options)).videos;
}
