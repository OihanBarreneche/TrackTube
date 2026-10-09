/**
 * Stand in for the YouTube client, for the benches.
 *
 * The real module needs the session, the page's configuration and the cookies:
 * outside the extension it can do nothing, and above all it must do nothing.
 * This one records the calls in `globalThis.__calls` and returns the response
 * the bench asks it to return.
 */

const calls = () => (globalThis.__calls ??= []);

/** The bench can lay `globalThis.__refuse = 'UC…'` down to simulate a refusal. */
function answer(action, channelId) {
  calls().push([action, channelId]);
  return Promise.resolve(globalThis.__refuse !== channelId);
}

export const subscribeChannel = (channelId) => answer('subscribe', channelId);
export const unsubscribeChannel = (channelId) => answer('unsubscribe', channelId);
