/**
 * The key of the YouTube account signed in to this tab, shared by the modules
 * of the isolated world.
 *
 * It lives in its own module rather than in `main.js` for an import reason:
 * triage, watch tracking and bulk list application all need it, and `main.js`
 * already imports them. Reading it from there would create a cycle.
 *
 * What that key is worth, how it is read and why it exists are explained in
 * `src/lib/account.js`. Here there is only a drawer.
 */

let key = null;
let foreign = false;

/** Set by `main.js` on every navigation, after reading the MAIN world. */
export function setAccountKey(value) {
  key = typeof value === 'string' && value ? value : null;
}

/** Set by `main.js` from the worker's answer to `ACCOUNT_SEEN`. */
export function setForeignAccount(value) {
  foreign = value === true;
}

/**
 * True when the tab's session is not the one the database belongs to.
 *
 * The worker already refuses writes coming from elsewhere, but some tasks have
 * to give up before they even start: re-reading the YouTube watch history and
 * reconciling subscriptions both stamp a "done today" timestamp and read lists
 * that are not the right ones. Letting them run only to be refused at the end
 * would waste their turn for the day.
 */
export function isForeignAccount() {
  return foreign;
}

/**
 * `null` until the configuration has been read, or while signed out. The
 * service worker treats a missing key as "we do not know" and lets it through:
 * that is the behaviour from before, and it beats blocking on a failed read.
 */
export function activeAccountKey() {
  return key;
}
