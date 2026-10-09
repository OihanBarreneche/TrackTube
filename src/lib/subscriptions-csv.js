/**
 * Reading the `subscriptions.csv` file exported by Google Takeout.
 *
 * This is the reliable way to recover the subscription list: the export is
 * complete by construction, whereas unrolling the page depends on the goodwill
 * of YouTube's progressive loading and can stop halfway through.
 *
 * The nominal format is:
 *
 *     Channel Id,Channel Url,Channel Title
 *     UCaNlbnghtwlsGF-KzAFThqA,http://www.youtube.com/channel/UCa…,ScienceEtonnante
 *
 * But the header is localised and the column order is not guaranteed. So we do
 * not rely on it: the identifier is recognised by its shape, and the title is
 * the remaining field that is not a URL.
 */

const RE_CHANNEL_ID = /^UC[\w-]{22}$/;

/**
 * Splits a CSV into rows of fields, honouring quotes.
 * A channel title may contain commas, quotes and line breaks.
 *
 * @param {string} text
 * @returns {string[][]}
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  // A BOM at the head of the file would stick to the first field.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (quoted) {
      if (ch !== '"') { field += ch; continue; }
      // Two consecutive quotes stand for one literal quote.
      if (input[i + 1] === '"') { field += '"'; i++; continue; }
      quoted = false;
      continue;
    }

    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }

    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
      continue;
    }

    field += ch;
  }

  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);

  return rows;
}

/**
 * Extracts the subscriptions from a Takeout CSV.
 *
 * Along the way it accepts any CSV with a column carrying a channel id,
 * including a plain list of `youtube.com/channel/UC…` URLs: it is the same
 * recognition by shape, and refusing those files would have served no purpose.
 * The `@name` handles, on the other hand, are not identifiers and would need to
 * be resolved against YouTube: they are counted as skipped.
 *
 * @param {string} text
 * @returns {{channels: Array<{id: string, title: string}>, skipped: number}}
 */
export function parseSubscriptionsCsv(text) {
  const channels = [];
  const seen = new Set();
  let skipped = 0;

  for (const row of parseCsv(text)) {
    const trimmed = row.map((f) => f.trim());
    // The identifier is recognised as is, or extracted from a channel URL: a
    // list pasted from the address bar is a perfectly legitimate file, and
    // requiring Takeout's bare column would be gratuitous.
    const id = trimmed.find((f) => RE_CHANNEL_ID.test(f))
      ?? trimmed.map((f) => f.match(/\/channel\/(UC[\w-]{22})/)?.[1]).find(Boolean);

    if (!id) { skipped++; continue; }        // header row or unexpected format
    if (seen.has(id)) continue;
    seen.add(id);

    // The title is the remaining field that is neither the id nor a URL.
    const title = trimmed.find((f) => f && f !== id && !/^https?:\/\//i.test(f)) ?? '';
    channels.push({ id, title: title.slice(0, 200) });
  }

  return { channels, skipped };
}

// ---------------------------------------------------------------------------
// Applying a list to an account
// ---------------------------------------------------------------------------

/** The three possible readings of a file. */
export const MODES = /** @type {const} */ ({
  /** Join the channels of the file we are not subscribed to yet. */
  SUBSCRIBE: 'subscribe',
  /** Leave the channels of the file we are subscribed to. */
  UNSUBSCRIBE: 'unsubscribe',
  /** Make the file the exact state of the account, in both directions. */
  ALIGN: 'align',
});

/**
 * What it would take to apply a file.
 *
 * The same file means three different things depending on the intent: a list of
 * channels to join, a list to leave, or the exact state the account should be
 * in. The mode is therefore not guessable and must be chosen explicitly —
 * confusing the last two would cost every subscription missing from the file.
 *
 * The function only describes: it calls nothing and decides nothing. That is
 * what makes it possible to show the complete plan before a single request goes
 * out, and to test it without a browser.
 *
 * @param {Array<{id: string, title?: string}>} file
 * @param {Array<{id: string, title?: string, active?: number|boolean}>} subscriptions
 * @param {string} mode
 * @returns {{toJoin: Array, toLeave: Array, unchanged: number, mode: string}}
 */
export function planApplication(file, subscriptions, mode = MODES.SUBSCRIBE) {
  // A deactivated channel is one we have already unsubscribed from: it is known
  // to the database but absent from the account, and counting it as a
  // subscription would drop real subscriptions to create from the plan.
  const active = new Map(
    (subscriptions ?? [])
      .filter((c) => c && c.id && c.active !== false && c.active !== 0)
      .map((c) => [c.id, c]),
  );

  const inFile = new Map();
  for (const c of file ?? []) if (c?.id) inFile.set(c.id, c);

  const name = (id, fallback) => ({
    id,
    title: inFile.get(id)?.title || active.get(id)?.title || fallback || id,
  });

  const toJoin = [];
  const toLeave = [];
  let unchanged = 0;

  if (mode === MODES.UNSUBSCRIBE) {
    for (const id of inFile.keys()) {
      if (active.has(id)) toLeave.push(name(id));
      else unchanged++;
    }
    return { toJoin, toLeave, unchanged, mode };
  }

  for (const id of inFile.keys()) {
    if (active.has(id)) unchanged++;
    else toJoin.push(name(id));
  }

  if (mode === MODES.ALIGN) {
    for (const [id, c] of active) {
      if (!inFile.has(id)) toLeave.push(name(id, c.title));
    }
  }

  return { toJoin, toLeave, unchanged, mode };
}
