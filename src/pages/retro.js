/**
 * Retrospective.
 *
 * The rest of the page answers questions; this one tells the story of a period.
 * The difference is deliberate: few figures, very large, one idea per screen,
 * and nothing to interpret. It is the only place in the extension where
 * legibility comes before precision — the nuances about duration estimation
 * have their own card elsewhere.
 *
 * Each screen is an SVG and not HTML. That is not a whim: it is what makes it
 * possible to export exactly what is displayed as an image, without writing the
 * layout a second time for a canvas.
 */

import { MSG, send } from '../lib/messages.js';
import { formatDuration, formatDelay, variation, coveredYears } from '../lib/history.js';
import { buildZip } from '../lib/zip.js';
import { t, bcp47 } from '../lib/i18n.js';

const NS = 'http://www.w3.org/2000/svg';
const W = 1080;
const H = 1350;

const number = (n) => new Intl.NumberFormat(bcp47()).format(n);
const $ = (id) => document.getElementById(id);

/** Screens built for the current period, and the one on display. */
let screens = [];
let index = 0;
/** Period on display: `{key, title, footer, from, to}`. */
let period = null;
/** Supplied by the page: the real bounds of the imported history. */
let readBounds = () => ({ from: null, to: null });

// ---------------------------------------------------------------------------
// SVG factory
// ---------------------------------------------------------------------------

function el(name, attrs = {}, content = null) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (content !== null) n.textContent = content;
  return n;
}

/**
 * An empty screen, background included.
 *
 * The background is painted inside the SVG and not by the stylesheet: on
 * export, the canvas only knows the content of the SVG, and a background set in
 * CSS would give a transparent image — hence light text on white, unreadable.
 */
function screen(hue) {
  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`,
    xmlns: NS,
    class: 'retro-svg',
  });

  // The id is derived from the hue, but without its hash sign: it is the target
  // of `url(#…)`, where a second hash would cut the reference short.
  const id = `g${hue.replace(/[^a-z0-9]/gi, '')}`;
  const grad = el('linearGradient', { id, x1: '0', y1: '0', x2: '0.4', y2: '1' });
  grad.append(el('stop', { offset: '0', 'stop-color': hue }));
  grad.append(el('stop', { offset: '1', 'stop-color': '#07070e' }));
  const defs = el('defs');
  defs.append(grad);
  svg.append(defs);

  svg.append(el('rect', { x: 0, y: 0, width: W, height: H, fill: '#07070e' }));
  svg.append(el('rect', { x: 0, y: 0, width: W, height: H, fill: `url(#${id})`, opacity: '.35' }));
  return svg;
}

const FONT = 'system-ui, sans-serif';

function text(svg, content, {
  x = W / 2, y, size = 40, weight = 400, color = '#e9e9f5',
  anchor = 'middle', opacity = 1,
}) {
  svg.append(el('text', {
    x, y, 'text-anchor': anchor, fill: color, opacity,
    'font-family': FONT, 'font-size': size, 'font-weight': weight,
  }, content));
}

/**
 * A relative change, with its sign, as a share.
 *
 * `signDisplay: 'exceptZero'` rather than a hand written plus: the minus sign
 * and the space before the percent differ by language, and writing them here
 * would produce "+8%" in a French screen.
 */
const signed = (ratio) => new Intl.NumberFormat(bcp47(), {
  style: 'percent', maximumFractionDigits: 0, signDisplay: 'exceptZero',
}).format(ratio);

/**
 * The size a hero line can take without leaving the frame.
 *
 * The cover already needed it, a year being four characters and "last 12
 * months" fourteen. Three screens need it now, so the rule lives in one place:
 * short strings get the full size, longer ones shrink in proportion.
 */
const heroSize = (s, max = 220) => (String(s).length <= 4
  ? max : Math.min(max * 0.7, 1500 / String(s).length));

/** Cuts a name that is too long rather than letting it spill out of the frame. */
function short(s, n = 24) {
  // Never `t` as a local name in this file: it is the name of the translation
  // function, and shadowing it has already cost a whole retrospective.
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

function footer(svg) {
  text(svg, period.footer, { y: H - 60, size: 26, color: '#82829c' });
}

// ---------------------------------------------------------------------------
// The screens
// ---------------------------------------------------------------------------

/**
 * A ranked column, which every podium screen draws with.
 *
 * It was a closure inside the channels screen until a second and a third
 * podium appeared. Three rankings have to be the same object on screen —
 * same rank size, same baseline, same grey for the value — and a renderer
 * copied twice drifts on the first change made to one of them.
 *
 * `cut` is the only thing that varies: a half width column holds sixteen
 * characters of a channel name, a full width one twice that.
 */
function podium(svg, {
  x, header, rows, value, y = 320, cut = 16,
}) {
  text(svg, header, { x, y, size: 30, weight: 600, color: '#aaaabf', anchor: 'start' });
  rows.forEach((row, i) => {
    const line = y + 110 + i * 130;
    text(svg, String(i + 1), { x, y: line, size: 52, weight: 800, anchor: 'start', opacity: 0.35 });
    text(svg, short(row.title, cut), {
      x: x + 60, y: line - 10, size: 34, weight: 600, anchor: 'start',
    });
    text(svg, value(row), {
      x: x + 60, y: line + 30, size: 27, color: '#aaaabf', anchor: 'start',
    });
  });
}

/** Day names, indexed like `Date.getDay()`: Sunday first. */
const weekdays = () => ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
  .map((j) => t(`hist.wd.${j}`));

function buildScreens(res) {
  const {
    stats: s, themes, streaks, previous, fastest, subscriptions, delays,
  } = res;
  const out = [];
  const hours = Math.round(s.totalSeconds / 3600);

  // 1. Cover.
  {
    const svg = screen('#5b4bf5');
    // A year fits in four characters, "last 12 months" does not: the size
    // follows the length, otherwise the title would leave the frame.
    const title = period.title;
    text(svg, title, {
      y: 520, size: title.length <= 4 ? 260 : Math.min(150, 1500 / title.length), weight: 800,
    });
    text(svg, t('hist.retro.cover.sub'), { y: 620, size: 44, color: '#d5d5e2' });
    text(svg, t('hist.nopened', { n: number(s.total) }), { y: 800, size: 46, weight: 600 });
    text(svg, t('hist.retro.cover.channels', { n: number(s.distinctChannels) }),
      { y: 870, size: 46, weight: 600 });
    text(svg, t('hist.retro.cover.days', { n: number(s.activeDays) }),
      { y: 940, size: 46, weight: 600 });
    footer(svg);
    out.push({ title: t('hist.retro.tab.cover'), svg });
  }

  // 2. Time, related to something tangible.
  {
    const svg = screen('#8a2be2');
    text(svg, t('hist.retro.time.you'), { y: 420, size: 48, color: '#d5d5e2' });
    text(svg, t('dur.hour', { n: number(hours) }), { y: 640, size: 220, weight: 800 });
    text(svg, t('hist.retro.time.front'), { y: 720, size: 48, color: '#d5d5e2' });
    text(svg, t('hist.retro.time.days', { n: number(Math.round(hours / 24)) }),
      { y: 880, size: 40 });
    // The decimal separator follows the language: `toFixed` would write a dot
    // everywhere.
    const perDay = (hours / (s.rangeDays || 1)).toLocaleString(bcp47(), {
      minimumFractionDigits: 1, maximumFractionDigits: 1,
    });
    text(svg, t('hist.retro.time.perday', { n: perDay }), { y: 940, size: 40 });

    // A total in large figures sticks; the assumption that produced it does
    // not. When the range is mostly measured, there is nothing to qualify: the
    // figure is then time really spent.
    if (s.timeMode !== 'real') {
      text(svg, t('hist.retro.time.assumed'),
        { y: 1010, size: 32, color: '#b3b3c6' });
    }
    footer(svg);
    out.push({ title: t('hist.retro.tab.time'), svg });
  }

  // 3. Against the period before.
  //
  // A total is a number until it has something to compare itself with: "61 h"
  // says nothing, "61 h, +8 %" is read at a glance. The comparison is always
  // the period of the same length immediately before — `previousRange` shifts
  // by the span and never by a calendar year, so seven days face the seven days
  // before them and a year faces a year.
  //
  // The screen is dropped rather than shown when nothing precedes: a first year
  // would otherwise announce a rise over zero.
  {
    const ratio = variation(s.totalSeconds, previous?.totalSeconds);
    if (ratio !== null) {
      const svg = screen('#00c7be');
      text(svg, t('hist.retro.vs.h'), { y: 220, size: 52, weight: 700 });

      const hero = signed(ratio);
      text(svg, hero, { y: 560, size: heroSize(hero), weight: 800 });
      text(svg, t('hist.retro.vs.time', {
        now: formatDuration(s.totalSeconds),
        before: formatDuration(previous.totalSeconds),
      }), { y: 650, size: 36, color: '#d5d5e2' });

      // Each of the three is dropped on its own when the period before held
      // none of it: a line reading "+∞" is worse than a missing line.
      [
        ['hist.retro.vs.opened', variation(s.total, previous.total)],
        ['hist.retro.vs.channels', variation(s.distinctChannels, previous.distinctChannels)],
        ['hist.retro.vs.days', variation(s.activeDays, previous.activeDays)],
      ].filter(([, r]) => r !== null)
        .forEach(([key, r], i) => {
          text(svg, t(key, { p: signed(r) }), { y: 860 + i * 70, size: 38 });
        });

      footer(svg);
      out.push({ title: t('hist.retro.vs.tab'), svg });
    }
  }

  // 4. The podium.
  {
    const svg = screen('#0a84ff');
    text(svg, t('hist.retro.ch.h'), { y: 220, size: 52, weight: 700 });

    // Two columns rather than a single podium: the ranking by number of videos
    // and the one by time do not say the same thing, and the gap between the
    // two is exactly what you come to look at. A podcast channel never appears
    // on the left and dominates on the right.
    const top = s.topChannels.slice(0, 5);
    const byTime = (s.topChannelsByTime ?? []).slice(0, 5);

    podium(svg, {
      x: 90, header: t('hist.retro.ch.bycount'), rows: top,
      value: (c) => t('hist.nvideos', { n: number(c.count) }),
    });
    podium(svg, {
      x: 570, header: t('hist.retro.ch.bytime'), rows: byTime,
      value: (c) => (c.seconds ? formatDuration(Math.round(c.seconds)) : '—'),
    });

    if (top[0]) {
      // Distinct videos over distinct videos: `s.total` counts openings and
      // would give a share the ranking above does not show.
      const share = s.uniqueVideos
        ? Math.round((top[0].count / s.uniqueVideos) * 100) : 0;
      text(svg, t('hist.retro.ch.weight', { ch: short(top[0].title, 20), p: share }),
        { y: H - 140, size: 32, color: '#d5d5e2' });
    }
    footer(svg);
    out.push({ title: t('hist.retro.ch.h'), svg });
  }

  // 5. How fast you pounce, and who you pounce on.
  //
  // The median delay belongs to nobody in particular; the podium is the half
  // that does, and someone with a median of three days usually has two or three
  // channels they open the same evening and a tail they get to eventually.
  //
  // This is the one screen no recap built elsewhere can produce: it needs the
  // publication date of every video, and only the feed index holds those.
  //
  // Four rows and not five, unlike the channels podium: there is a hero above
  // it here, and a fifth row would land on the footer.
  {
    const median = delays?.median;
    if (Number.isFinite(median)) {
      const svg = screen('#bf5af2');
      text(svg, t('hist.retro.fast.h'), { y: 220, size: 52, weight: 700 });

      const hero = formatDelay(median);
      text(svg, hero, { y: 430, size: heroSize(hero, 150), weight: 800 });
      text(svg, t('hist.retro.fast.median'), { y: 500, size: 36, color: '#d5d5e2' });

      // `fastest` is absent from an answer cached before this screen existed,
      // and the screen then shows its median alone rather than failing.
      const rows = (fastest?.channels ?? []).slice(0, 4);
      if (rows.length) {
        podium(svg, {
          x: 90, y: 620, cut: 26, header: t('hist.retro.fast.col'), rows,
          value: (c) => t('hist.retro.fast.row', {
            d: formatDelay(c.median), n: number(c.n),
          }),
        });
        text(svg, t('hist.retro.fast.scope', { min: number(fastest.minVideos ?? 3) }),
          { y: H - 140, size: 30, color: '#b3b3c6' });
      }
      footer(svg);
      out.push({ title: t('hist.retro.fast.tab'), svg });
    }
  }

  // 6. The rhythm.
  {
    const svg = screen('#ff9f0a');
    const peakHour = s.perHour.indexOf(Math.max(...s.perHour));
    const peakDay = s.perWeekday.indexOf(Math.max(...s.perWeekday));
    const biggestDay = (s.dailySeries ?? [])
      .reduce((m, x) => (x[1] > (m?.[1] ?? 0) ? x : m), null);

    text(svg, t('hist.retro.rhy.h'), { y: 220, size: 52, weight: 700 });
    text(svg, t('dur.hour', { n: peakHour }), { y: 480, size: 190, weight: 800 });
    text(svg, t('hist.retro.rhy.hour'), { y: 550, size: 40, color: '#d5d5e2' });
    text(svg, t('hist.retro.rhy.day', { day: weekdays()[peakDay] }), { y: 760, size: 40 });

    if (biggestDay) {
      const d = new Date(`${biggestDay[0]}T12:00:00`);
      text(svg, t('hist.retro.rhy.record', { n: number(biggestDay[1]) }), { y: 880, size: 40 });
      text(svg, d.toLocaleDateString(bcp47(), { day: 'numeric', month: 'long', year: 'numeric' }),
        { y: 940, size: 40, weight: 600 });
    }
    if (s.longestStreak > 1) {
      text(svg, t('hist.retro.rhy.streak', { n: number(s.longestStreak) }),
        { y: H - 140, size: 32, color: '#d5d5e2' });
    }
    footer(svg);
    out.push({ title: t('hist.retro.rhy.h'), svg });
  }

  // 7. The words that keep coming back.
  {
    const svg = screen('#30d158');
    text(svg, t('hist.retro.words.h'), { y: 220, size: 52, weight: 700 });

    const words = (themes ?? []).slice(0, 8);
    words.forEach((word, i) => {
      // The size follows the rank, not the frequency: a leading theme twice as
      // frequent would crush all the others down to illegibility.
      const size = 74 - i * 6;
      text(svg, short(word.text, 26), { y: 400 + i * 108, size, weight: 700, opacity: 1 - i * 0.07 });
      text(svg, number(word.n), {
        x: W - 120, y: 400 + i * 108, size: 30, color: '#aaaabf', anchor: 'end',
      });
    });
    footer(svg);
    out.push({ title: t('hist.retro.tab.words'), svg });
  }

  // 8. Loyalty.
  {
    const svg = screen('#ff375f');
    const streak = (streaks ?? [])[0];
    text(svg, t('hist.retro.loyal.h'), { y: 220, size: 52, weight: 700 });

    if (streak) {
      text(svg, `${number(streak.streak)}`, { y: 520, size: 220, weight: 800 });
      text(svg, t('hist.retro.loyal.inrow'), { y: 600, size: 40, color: '#d5d5e2' });
      text(svg, short(streak.title, 24), { y: 700, size: 54, weight: 700 });
    } else {
      text(svg, t('hist.retro.loyal.none'), { y: 560, size: 54, weight: 700 });
      text(svg, t('hist.retro.loyal.none.p'), { y: 630, size: 38, color: '#d5d5e2' });
    }

    const share = Math.round((s.subscriptionShare ?? 0) * 100);
    const top10 = (s.concentration ?? []).find((p) => p.n === 10);
    text(svg, t('hist.retro.loyal.subs', { p: share }), { y: 880, size: 36 });
    if (top10) {
      text(svg, t('hist.retro.loyal.top10', { p: Math.round(top10.share * 100) }),
        { y: 940, size: 36 });
    }
    footer(svg);
    out.push({ title: t('hist.retro.loyal.h'), svg });
  }

  // 9. The subscriptions put to the test.
  //
  // "You watched 47 of your 312 channels" reads as an indictment over a week
  // where two hundred of them published nothing at all, so the number that did
  // publish sits under the figure and gives it its real denominator.
  //
  // The share is printed only when it can be true. Watching more channels than
  // published over the range is perfectly possible — you opened something from
  // a back catalogue — and the percentage would then pass a hundred, which
  // reads as a bug rather than as the fact it is.
  //
  // The second half is the mirror: what you watch most without being subscribed
  // to it. That is what makes this the screen the subscription sorting follows
  // from.
  {
    if (subscriptions?.total) {
      const svg = screen('#64d2ff');
      text(svg, t('hist.retro.subs.h'), { y: 220, size: 52, weight: 700 });

      const watched = subscriptions.watchedInRange ?? 0;
      text(svg, number(watched), { y: 450, size: 190, weight: 800 });
      text(svg, t('hist.retro.subs.of', { total: number(subscriptions.total) }),
        { y: 520, size: 36, color: '#d5d5e2' });

      const active = subscriptions.activeInRange ?? 0;
      if (active > 0) {
        text(svg, watched <= active
          ? t('hist.retro.subs.active', {
            n: number(active), p: Math.round((watched / active) * 100),
          })
          : t('hist.retro.subs.active.plain', { n: number(active) }),
        { y: 580, size: 34, color: '#b3b3c6' });
      }

      const rows = (subscriptions.candidates ?? []).slice(0, 4);
      if (rows.length) {
        podium(svg, {
          x: 90, y: 700, cut: 26, header: t('hist.retro.subs.col'), rows,
          value: (c) => t('hist.nvideos', { n: number(c.count) }),
        });
      }
      footer(svg);
      out.push({ title: t('hist.retro.subs.tab'), svg });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

function show(i) {
  if (!screens.length) return;
  index = Math.max(0, Math.min(screens.length - 1, i));
  $('retro-scene').replaceChildren(screens[index].svg);
  $('retro-position').textContent = `${index + 1} / ${screens.length}`;
  $('retro-prev').disabled = index === 0;
  $('retro-next').disabled = index === screens.length - 1;

  $('retro-dots').replaceChildren(...screens.map((e, n) => {
    const p = document.createElement('button');
    p.className = n === index ? 'point active' : 'point';
    p.setAttribute('aria-label', e.title);
    p.addEventListener('click', () => show(n));
    return p;
  }));
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

/**
 * The periods on offer.
 *
 * Calendar years first, because that is the expected shape of a retrospective,
 * then a few rolling windows down to the week. The week was left out at first,
 * on the grounds that streaks, favourite hours and recurring words have little
 * to say over seven days — which is true of the statistics and beside the point
 * for the screens: a week of viewing put into images is exactly what one wants
 * to look at on a Sunday evening, and the screens degrade gracefully when a
 * figure is thin.
 *
 * The years are drawn from the real history: offering 2019 to someone whose
 * export starts in 2024 would only give empty screens.
 */
function availablePeriods() {
  const bounds = readBounds();
  const years = coveredYears(bounds.from, bounds.to).map((year) => ({
    key: String(year),
    title: String(year),
    footer: t('hist.retro.p.year', { year }),
    from: Date.parse(`${year}-01-01T00:00:00`),
    to: Date.parse(`${year}-12-31T23:59:59`),
  }));

  const now = Date.now();
  const rolling = (days, title) => ({
    key: `${days}j`,
    title,
    footer: t('hist.retro.p.rolling', { p: title.toLowerCase() }),
    from: now - days * 86_400_000,
    to: now,
  });

  return [
    ...years,
    rolling(365, t('hist.retro.p.12m')),
    rolling(90, t('hist.retro.p.3m')),
    rolling(30, t('hist.retro.p.30d')),
    rolling(7, t('hist.retro.p.7d')),
  ];
}

function fillPeriodChoice(periods) {
  $('retro-range').replaceChildren(...periods.map((p) => {
    const o = document.createElement('option');
    o.value = p.key;
    o.textContent = p.title;
    return o;
  }));
  $('retro-range').value = period.key;
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

/**
 * Builds the retrospective of one period.
 *
 * Nothing is recomputed from scratch: it is the same message as the main page,
 * over another range. The screens only choose what to show.
 */
async function build() {
  $('retro-scene').replaceChildren(Object.assign(document.createElement('p'), {
    className: 'muted', textContent: t('hist.retro.building'),
  }));
  $('retro-position').textContent = '';
  $('retro-dots').replaceChildren();

  const expected = period.key;
  const res = await send(MSG.HISTORY_STATS, { from: period.from, to: period.to, topN: 15 });
  // The period may have changed during the computation: displaying a stale
  // result would be worse than displaying nothing.
  if (period.key !== expected) return;

  if (!res?.ok || !res.stats?.total) {
    $('retro-scene').replaceChildren(Object.assign(document.createElement('p'), {
      className: 'muted',
      textContent: t('hist.retro.empty', { p: period.title }),
    }));
    screens = [];
    return;
  }

  // A screen that fails must not leave "Building" on display forever. The
  // building message is put up before the wait and nothing erased it on error:
  // the page looked like it was computing indefinitely.
  try {
    screens = buildScreens(res);
  } catch (err) {
    console.error('Retrospective failed', err);
    $('retro-scene').replaceChildren(Object.assign(document.createElement('p'), {
      className: 'muted', textContent: t('hist.retro.fail'),
    }));
    screens = [];
    return;
  }
  show(0);
}

export async function openRetro() {
  const periods = availablePeriods();
  if (!periods.length) return;

  // We reopen on the period already being looked at, if it still exists.
  period = periods.find((p) => p.key === period?.key) ?? periods[0];

  $('retro-dialog').showModal();
  $('retro-dialog').focus();
  fillPeriodChoice(periods);
  await build();
}

// ---------------------------------------------------------------------------
// Image export
// ---------------------------------------------------------------------------

/**
 * Rasterises the screen on display.
 *
 * The SVG is serialised then drawn into a canvas at its nominal size: we get
 * exactly what is on screen, at full resolution rather than at display size. No
 * remote image enters the SVG — otherwise the canvas would be "tainted" and
 * `toBlob` would refuse to produce anything.
 */
async function rasterise(node) {
  const svg = node.cloneNode(true);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  const source = new XMLSerializer().serializeToString(svg);
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;

  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error(t('hist.retro.badsvg')));
    image.src = url;
  });

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#07070e';
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(image, 0, 0, W, H);

  return new Promise((r) => canvas.toBlob(r, 'image/png'));
}

/** The period, as a file name can carry it. */
const slug = () => period.key.replace(/[^a-z0-9]+/gi, '').toLowerCase();

/**
 * Hands a blob over as a file.
 *
 * Through an `<a download>` and not `chrome.downloads`: that permission was
 * dropped in 1.0.0 because this one call was the only thing asking for it.
 */
function handOver(blob, name) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 5000);
}

async function exportPng() {
  if (!screens.length) return;
  handOver(await rasterise(screens[index].svg), `retrospective_${slug()}_${index + 1}.png`);
}

/**
 * The whole deck, in one archive.
 *
 * A ZIP rather than the alternatives, and each was weighed: one tall strip of
 * nine cards is unreadable and shareable nowhere, a contact sheet halves the
 * type on cards drawn to be read full bleed, and nine automatic downloads in a
 * row make Chrome ask for permission. `src/lib/zip.js` says why the entries go
 * in uncompressed.
 *
 * The numbers are padded to two digits because a file manager sorts names as
 * text: without it the tenth card lands between the first and the second.
 *
 * The button counts as it goes. Nine cards go through an image decode and a
 * canvas each, which is a second or two, and a control that looks dead for two
 * seconds gets clicked again.
 */
async function exportAll() {
  if (!screens.length) return;
  const button = $('retro-zip');
  const label = button.textContent;
  button.disabled = true;

  try {
    const files = [];
    for (let i = 0; i < screens.length; i++) {
      button.textContent = t('hist.retro.zipping', { i: i + 1, n: screens.length });
      // Sequentially on purpose: nine canvases of 1080 x 1350 held at once is
      // fifty megabytes of bitmap for no gain, the cost being the decode.
      // eslint-disable-next-line no-await-in-loop
      const blob = await rasterise(screens[i].svg);
      files.push({
        name: `retrospective_${slug()}_${String(i + 1).padStart(2, '0')}.png`,
        // eslint-disable-next-line no-await-in-loop
        data: new Uint8Array(await blob.arrayBuffer()),
      });
    }
    handOver(new Blob([buildZip(files)], { type: 'application/zip' }),
      `retrospective_${slug()}.zip`);
  } finally {
    button.textContent = label;
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export function wireRetro(provideBounds) {
  readBounds = provideBounds;

  $('retro-prev').addEventListener('click', () => show(index - 1));
  $('retro-next').addEventListener('click', () => show(index + 1));
  $('retro-close').addEventListener('click', () => $('retro-dialog').close());
  $('retro-png').addEventListener('click', exportPng);
  $('retro-zip').addEventListener('click', exportAll);

  $('retro-range').addEventListener('change', async () => {
    const chosen = availablePeriods().find((p) => p.key === $('retro-range').value);
    if (!chosen) return;
    period = chosen;
    await build();
  });

  // The arrow keys page through the screens: it is the expected gesture of a
  // slideshow, and without it you have to aim at two small buttons to go
  // through everything.
  $('retro-dialog').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); show(index + 1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); show(index - 1); }
  });
}
