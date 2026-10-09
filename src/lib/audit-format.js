/**
 * Rendering of the audit report.
 *
 * Deliberately split from the audit engine: the popup needs nothing else, and
 * importing `background/audit.js` would make it open a second IndexedDB
 * connection for nothing.
 *
 * The three figures are aligned at run time rather than in the catalogue: the
 * labels do not have the same length from one language to the next, and padding
 * frozen into the translations would drift the moment a word changed.
 *
 * @param {object} r  report produced by runAudit()
 */

import { t, bcp47 } from './i18n.js';

export function formatAuditReport(r) {
  if (!r?.ok) {
    // The reason is an identifier produced by the worker: here, on the side
    // that knows the language, is where it becomes a sentence.
    if (r?.reason === 'no-harvest') return t('audit.reason.noharvest');
    return t('audit.impossible', { reason: r?.reason ?? t('audit.reason.unknown') });
  }

  const pct = (r.missedRatio * 100).toLocaleString(bcp47(), {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const window = r.truncated
    ? t('audit.window.truncated', { n: r.truncatedTo })
    : t('audit.window', { n: r.windowDays });

  const lines = [
    t('audit.title', { window }),
    '',
    ...align([
      [t('audit.total'), String(r.total)],
      [t('audit.seen'), String(r.seenByYoutube)],
      [t('audit.missed'), `${r.missedCount}  (${pct} %)`],
    ]),
    '',
  ];

  if (r.missedCount === 0) {
    lines.push(`  ${t('audit.none')}`);
    return lines.join('\n');
  }

  lines.push(`  ${t('audit.channels', { n: r.channelsAffectedCount })}`, '');
  for (const c of r.channelsAffected.slice(0, 15)) {
    lines.push(`  ${String(c.missed).padStart(3)} × ${c.title}`);
  }

  // Without this caveat the figure would mislead. A video you hid yourself
  // through YouTube's own "Hide" disappears from the native feed, so the
  // harvest never sees it — exactly like a video YouTube never showed. The two
  // cases are indistinguishable after the fact.
  lines.push(
    '',
    `  ${t('audit.caveat.h')}`,
    ...wrap(t('audit.caveat.p1')),
    '',
    ...wrap(t('audit.caveat.p2')),
  );

  return lines.join('\n');
}

/** Renders the YouTube → TrackTube comparison and names every actual gap. */
export function formatReverseAuditReport(r) {
  if (!r?.ok) {
    if (r?.reason === 'no-reverse-harvest') return t('reverse.reason.noharvest');
    if (r?.reason === 'no-youtube-tab') return t('reverse.reason.notab');
    if (r?.reason === 'source-unavailable') return t('reverse.reason.unavailable');
    if (r?.reason === 'other-account') return t('reverse.reason.account');
    if (r?.reason === 'no-harvest') return t('audit.reason.noharvest');
    return t('audit.impossible', { reason: r?.reason ?? t('audit.reason.unknown') });
  }

  const lines = [
    t('reverse.title', { window: t('audit.window', { n: r.windowDays }) }),
    '',
    t('reverse.result', { n: r.missingCount }),
    '',
    ...align([
      [t('reverse.total'), String(r.total)],
      [t('reverse.present'), String(r.presentCount)],
      [t('reverse.shorts'), String(r.excludedShortsCount)],
      [t('reverse.undated.checked'), String(r.undatedCount)],
      // Shown even at zero: a reader who cannot see that the question was asked
      // has no reason to believe the headline figure answers only it.
      [t('reverse.offlist'), String(r.missingUnfollowedCount ?? 0)],
      [t('reverse.inactive'), String(r.missingInactiveCount ?? 0)],
    ]),
    '',
  ];

  if (!r.coveredWindow) {
    lines.push(`  ${t('reverse.incomplete', { n: r.coveredDays ?? '?' })}`, '');
  }
  if (r.boundaryUnknownCount) {
    lines.push(`  ${t('reverse.boundary.unknown', { n: r.boundaryUnknownCount })}`, '');
  }
  if (r.unresolvedCount) {
    lines.push(`  ${t('reverse.unresolved', { n: r.unresolvedCount })}`, '');
  }

  if (!r.missingCount) lines.push(`  ${t('reverse.none', { n: r.total })}`);
  else {
    lines.push(`  ${t('reverse.missing.list')}`, '');
    for (const video of r.missing) lines.push(...videoLines(video));
  }

  // A channel taken out of the sweep is worth more than the video it cost: the
  // videos go on being published and none of them will arrive.
  if (r.missingInactiveCount) {
    lines.push('', `  ${t('reverse.inactive.list')}`, '');
    for (const channel of r.inactiveChannels ?? []) lines.push(`  ${channel.title}`);
    lines.push('', ...wrap(t('reverse.inactive.note')));
  }

  // Not a verdict, a question put to the reader: only they know whether they
  // are subscribed to these channels.
  if (r.missingUnfollowedCount) {
    lines.push('', `  ${t('reverse.offlist.list')}`, '');
    for (const channel of r.unfollowedChannels ?? []) lines.push(`  ${channel.title}`);
    lines.push('', ...wrap(t('reverse.offlist.note')));
  }

  if (r.missingUnattributedCount) {
    lines.push('', ...wrap(t('reverse.unattributed', { n: r.missingUnattributedCount })));
  }

  // Last line, always: the figure at the top describes what was actually loaded
  // while YouTube's feed was read, and a report silent about that reads as a
  // certificate of completeness it cannot deliver.
  lines.push('', ...wrap(t('reverse.caveat')));

  return lines.join('\n');
}

function videoLines(video, withDate = true) {
  const label = video.title || video.id;
  const channel = video.channelTitle ? ` — ${video.channelTitle}` : '';
  const date = withDate && Number.isFinite(video.publishedAt)
    ? ` — ${new Date(video.publishedAt).toLocaleDateString(bcp47())}`
    : '';
  return [
    `  ${label}${channel}${date}`,
    `  https://www.youtube.com/watch?v=${video.id}`,
  ];
}

/** Labels padded to a common width, so the numbers line up in a column. */
function align(pairs) {
  const width = Math.max(...pairs.map(([label]) => label.length));
  return pairs.map(([label, value]) => `  ${label.padEnd(width)} : ${value}`);
}

/** The report shows in a monospaced block that does not wrap on its own. */
function wrap(text, width = 68) {
  const lines = [];
  let current = '';
  for (const word of text.split(' ')) {
    if (current && current.length + 1 + word.length > width) {
      lines.push(`  ${current}`);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(`  ${current}`);
  return lines;
}
