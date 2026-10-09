/**
 * Identity of the signed in YouTube account.
 *
 * The whole extension database lives in the IndexedDB of its origin, which is
 * attached to the **browser profile** and not to the Google account. Switching
 * account inside the same profile therefore changes nothing for it: without a
 * guard, one account's subscriptions, another's watch sessions and a third's
 * detected unsubscribes all get written to the same place. The case is not
 * theoretical — the daily reconciliation re-reads the subscription list of the
 * signed in account and deactivates everything missing from it.
 *
 * There is an identifier that settles the question, and YouTube itself uses it
 * to partition its own local caches: `DATASYNC_ID`, in the page's `ytcfg`
 * configuration. Measured as a visitor on `youtube.com` in August 2026, it
 * reads `Ved2ffbf6||` with `LOGGED_IN: false` — so it exists outside a session
 * too, and then means nothing. `LOGGED_IN` is what decides whether there is an
 * identity to read at all.
 *
 * Its shape is `delegate||principal`: the second field is the Google account,
 * the first the active channel when a brand channel is in use. We keep the
 * whole string rather than extracting a part of it — two channels of the same
 * account yield two different values, which is exactly the partitioning we
 * want, and no assumption about the field layout can go stale.
 *
 * These functions are pure: they touch neither the network, nor the DOM, nor
 * the database.
 */

/**
 * The key of the signed in account, or `null` if there is none.
 *
 * @param {{loggedIn?: boolean, datasyncId?: string}} [cfg]
 * @returns {string|null}
 */
export function accountKey(cfg) {
  if (!cfg?.loggedIn) return null;
  const raw = typeof cfg.datasyncId === 'string' ? cfg.datasyncId.trim() : '';
  // The expected shape carries the separator. A value without it is not the
  // one we think we are reading: better to conclude nothing than to partition
  // on an identifier whose nature we do not know.
  return raw.includes('||') ? raw : null;
}

/**
 * Does this observation come from the account the database belongs to?
 *
 * Three situations make the answer `true` without there being equality, and
 * each of them is deliberate:
 *
 * - the database has no owner yet, so there is nothing to contradict;
 * - the observation carries no key, because it comes from older code or from a
 *   page that could not read the configuration;
 * - the page is seen signed out, where no personal data is readable anyway.
 *
 * @param {string|null|undefined} owner
 * @param {string|null|undefined} observed
 */
export function sameAccount(owner, observed) {
  if (!owner || !observed) return true;
  return owner === observed;
}
