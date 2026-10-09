/**
 * Mini game: "which of the two?"
 *
 * The rest of the page shows figures you read. Here you bet on them before
 * seeing them, and that gap is what is interesting: you think you know your own
 * consumption, and being wrong two times out of three says more than a tidy
 * ranking. It is a game, unashamedly — the value is not statistical.
 *
 * The module computes nothing: it replays the directory the page already
 * loaded.
 */

import { formatDuration } from '../lib/history.js';
import { t, bcp47 } from '../lib/i18n.js';

const $ = (id) => document.getElementById(id);
const number = (n) => new Intl.NumberFormat(bcp47()).format(n);
const date = (ts) => new Date(ts).toLocaleDateString(bcp47(),
  { day: 'numeric', month: 'long', year: 'numeric' });
/** Views run to seven figures: written in full they are unreadable. */
const compact = (n) => new Intl.NumberFormat(bcp47(),
  { notation: 'compact', maximumFractionDigits: 1 }).format(n);

/**
 * An upload cadence, said the way one says it out loud.
 *
 * Below a day and a half, counting the days gives “every 1 day”, which nobody
 * says: the rate is turned over instead.
 */
function cadence(intervalMs) {
  const days = intervalMs / 86400000;
  return days >= 1.5
    ? t('hist.game.every', { n: number(Math.round(days)) })
    : t('hist.game.perday', { n: number(Math.round(10 / Math.max(days, 0.05)) / 10) });
}

/** Supplied by the page: it owns the directory, the game uses it. */
let readDirectory = async () => [];

/** Channels kept for the draw, filtered once per game. */
let pool = [];
let score = 0;
let best = 0;
/** Current round: `{a, b, question, winner}`. */
let round = null;
/** Lock between the click and the display of the next round. */
let frozen = false;

// ---------------------------------------------------------------------------
// The questions
// ---------------------------------------------------------------------------

/**
 * Each question knows what it compares and how to display it.
 *
 * `value` must stay increasing: the right answer is always the larger of the
 * two, which avoids duplicating the comparison logic. A question that reads the
 * other way round — "which did you discover first" — negates its own value
 * rather than adding a direction to the engine.
 *
 * Three optional fields:
 *  - `usable(c)`  channels this question can be asked about at all;
 *  - `minGap`     absolute difference below which the pair is not a question;
 *  - `scale`      opts the question out of the narrowing below. `'date'` for
 *                 milliseconds since 1970, whose ratio is always about one;
 *                 `'wide'` for the channel side quantities, whose whole
 *                 interest is the order of magnitude between the two.
 */
const QUESTIONS = [
  {
    // "Which one did you watch most" did not say whether we were comparing
    // videos or hours, while the next question compares time. Each wording now
    // names its quantity.
    key: 'hist.game.q.videos',
    value: (c) => c.count,
    display: (c) => t('hist.nvideos', { n: number(c.count) }),
  },
  {
    key: 'hist.game.q.time',
    value: (c) => c.seconds,
    display: (c) => formatDuration(Math.round(c.seconds)),
    // Without a fetched duration, the question compares two zeros.
    usable: (c) => c.seconds > 0,
  },
  {
    key: 'hist.game.q.recent',
    value: (c) => c.lastSeen,
    scale: 'date',
    display: (c) => date(c.lastSeen),
  },
  {
    // The mirror of the previous one, and the more interesting of the two: one
    // remembers what one watched yesterday, not what one started five years
    // ago. Negated so that the larger value stays the right answer.
    key: 'hist.game.q.first',
    value: (c) => -c.firstSeen,
    scale: 'date',
    usable: (c) => c.firstSeen > 0,
    display: (c) => date(c.firstSeen),
  },
  {
    // Openings per distinct video. The gap has to be real: two channels at 1.1
    // and 1.3 rewatches are not something anyone can tell apart, and a question
    // nobody can answer is not a question.
    key: 'hist.game.q.rewatch',
    value: (c) => c.opens / Math.max(1, c.count),
    minGap: 0.5,
    usable: (c) => c.count >= 3,
    display: (c) => t('hist.game.rewatch', {
      n: (c.opens / Math.max(1, c.count)).toFixed(1).replace('.0', ''),
    }),
  },
  {
    key: 'hist.game.q.month.time',
    value: (c) => c.month?.seconds ?? 0,
    usable: (c) => (c.month?.seconds ?? 0) > 0,
    display: (c) => formatDuration(Math.round(c.month.seconds)),
  },
  {
    key: 'hist.game.q.month.videos',
    value: (c) => c.month?.count ?? 0,
    usable: (c) => (c.month?.count ?? 0) > 0,
    display: (c) => t('hist.nvideos', { n: number(c.month.count) }),
  },
  {
    key: 'hist.game.q.year.time',
    value: (c) => c.year?.seconds ?? 0,
    usable: (c) => (c.year?.seconds ?? 0) > 0,
    display: (c) => formatDuration(Math.round(c.year.seconds)),
  },
  {
    key: 'hist.game.q.year.videos',
    value: (c) => c.year?.count ?? 0,
    usable: (c) => (c.year?.count ?? 0) > 0,
    display: (c) => t('hist.nvideos', { n: number(c.year.count) }),
  },

  // What the channel does, not what we do with it. Everything below spans
  // orders of magnitude — a daily uploader against a quarterly one, two million
  // views against three thousand — which is exactly what the questions above
  // cannot offer: nobody watches one channel a hundred times more than another.
  {
    // The interval is a median gap, so the smaller wins: negated, like the
    // discovery date, rather than teaching the engine a direction.
    key: 'hist.game.q.cadence',
    value: (c) => -(c.uploadIntervalMs ?? 0),
    scale: 'wide',
    usable: (c) => c.uploadIntervalMs > 0,
    display: (c) => cadence(c.uploadIntervalMs),
  },
  {
    key: 'hist.game.q.uploads',
    note: 'hist.game.n.collected',
    value: (c) => c.videos ?? 0,
    scale: 'wide',
    usable: (c) => (c.videos ?? 0) > 0,
    display: (c) => t('hist.nvideos', { n: number(c.videos) }),
  },
  {
    key: 'hist.game.q.lastup',
    value: (c) => c.lastUploadAt ?? 0,
    scale: 'date',
    usable: (c) => c.lastUploadAt > 0,
    display: (c) => date(c.lastUploadAt),
  },
  {
    key: 'hist.game.q.views',
    note: 'hist.game.n.collected',
    value: (c) => c.views ?? 0,
    scale: 'wide',
    usable: (c) => (c.views ?? 0) > 0,
    display: (c) => t('hist.game.views', { n: compact(c.views) }),
  },
  {
    key: 'hist.game.q.meanviews',
    note: 'hist.game.n.collected',
    value: (c) => (c.views ?? 0) / Math.max(1, c.viewsSamples ?? 0),
    scale: 'wide',
    // Below three measured videos the mean is an accident of the sample.
    usable: (c) => (c.viewsSamples ?? 0) >= 3,
    display: (c) => t('hist.game.views', {
      n: compact(Math.round(c.views / c.viewsSamples)),
    }),
  },
  {
    key: 'hist.game.q.bestvideo',
    note: 'hist.game.n.collected',
    value: (c) => c.bestViews ?? 0,
    scale: 'wide',
    usable: (c) => (c.bestViews ?? 0) > 0,
    display: (c) => t('hist.game.bestvideo', {
      n: compact(c.bestViews), title: c.bestTitle,
    }),
  },
  {
    // Read from the feed index, hence from the `UULF` playlist: a Short never
    // pulls this mean down.
    key: 'hist.game.q.length',
    note: 'hist.game.n.collected',
    value: (c) => (c.durTotal ?? 0) / Math.max(1, c.durCount ?? 0),
    scale: 'wide',
    usable: (c) => (c.durCount ?? 0) >= 3,
    display: (c) => formatDuration(Math.round(c.durTotal / c.durCount)),
  },
];

// ---------------------------------------------------------------------------
// Drawing a round
// ---------------------------------------------------------------------------

const random = (n) => Math.floor(Math.random() * n);

/**
 * Draws a round, tighter and tighter.
 *
 * Pitting the number one channel against a channel watched three times is not a
 * question, it is a formality. The tolerated gap narrows as the score rises:
 * the first rounds are won, the later ones are played. The draw is bounded in
 * attempts because a narrow pool may offer no pair close enough, and an easy
 * round beats an infinite loop.
 */
function drawRound() {
  const maxGap = Math.max(1.15, 6 / (1 + score * 0.5));

  for (let attempt = 0; attempt < 400; attempt++) {
    const question = QUESTIONS[random(QUESTIONS.length)];
    const eligible = question.usable ? pool.filter(question.usable) : pool;
    if (eligible.length < 2) continue;

    const a = eligible[random(eligible.length)];
    const b = eligible[random(eligible.length)];
    if (a === b) continue;

    const va = question.value(a);
    const vb = question.value(b);
    if (va === vb) continue;

    // An absolute floor, where a ratio says nothing: 1.1 against 1.3 rewatches
    // is a ratio of 1.18, which the narrowing would happily accept, and which
    // no one can tell apart. Unlike the narrowing, this one never relaxes.
    if (question.minGap && Math.abs(va - vb) < question.minGap) continue;

    const ratio = Math.max(va, vb) / Math.max(1, Math.min(va, vb));
    if (!question.scale && attempt < 300 && ratio > maxGap) continue;

    return { a, b, question, winner: va > vb ? a : b };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/**
 * The channel's picture, or its initial.
 *
 * The monogram is a fallback and not merely the other branch: an avatar URL can
 * be stale — YouTube's `yt3` addresses are signed and expire — and the broken
 * image icon looked like a bug in the game. On error the picture is replaced by
 * the initial, which always renders.
 */
function avatar(c) {
  const disc = document.createElement('span');
  disc.className = 'game-avatar game-avatar-initial';
  disc.textContent = (c.title ?? '?').trim().charAt(0).toUpperCase() || '?';
  if (!c.avatarUrl) return disc;

  const img = document.createElement('img');
  img.className = 'game-avatar';
  img.src = c.avatarUrl;
  img.alt = '';
  img.addEventListener('error', () => img.replaceWith(disc), { once: true });
  return img;
}

function card(c, side) {
  const el = document.createElement('button');
  el.className = 'game-card';
  el.dataset.side = side;

  el.append(avatar(c));

  const name = document.createElement('b');
  name.textContent = c.title;
  const val = document.createElement('span');
  val.className = 'game-value';
  el.append(name, val);

  el.addEventListener('click', () => answer(c));
  return el;
}

function drawBoard() {
  $('game-question').textContent = t(round.question.key);
  // A figure read over the videos we hold is not the channel's whole life, and
  // the question has to say so rather than let the number pass for a total.
  $('game-note').textContent = round.question.note ? t(round.question.note) : '';
  $('game-score').textContent = t('hist.game.streak', { n: score });
  $('game-record').textContent = best ? t('hist.game.record', { n: best }) : '';
  $('game-verdict').textContent = '';
  $('game-verdict').className = 'game-verdict';
  $('game-again').hidden = true;
  $('game-cards').replaceChildren(card(round.a, 'a'), card(round.b, 'b'));
}

/**
 * Reveals both figures before concluding.
 *
 * Even lost, the round must teach something: hiding the values would reduce the
 * game to a coin toss, whereas its whole point is to see the gap between what
 * you believed and what is.
 */
function reveal(won) {
  for (const el of $('game-cards').children) {
    const c = el.dataset.side === 'a' ? round.a : round.b;
    el.querySelector('.game-value').textContent = round.question.display(c);
    el.classList.add(c === round.winner ? 'right-answer' : 'wrong');
    el.disabled = true;
  }

  const v = $('game-verdict');
  v.className = won ? 'game-verdict won' : 'game-verdict lost';
  v.textContent = won
    ? t('hist.game.right')
    : t('hist.game.wrong', { ch: round.winner.title, n: score });
}

async function answer(choice) {
  if (frozen || !round) return;
  frozen = true;

  const won = choice === round.winner;
  if (won) score++;
  // The counter rises with the reveal, not on the next round: seeing "Well
  // spotted" under an unchanged streak felt like a bug.
  $('game-score').textContent = t('hist.game.streak', { n: score });
  reveal(won);

  if (won) {
    if (score > best) {
      best = score;
      $('game-record').textContent = t('hist.game.record', { n: best });
      await chrome.storage.local.set({ histoJeuRecord: best });
    }
    // A short pause: enough to read the two revealed figures, not enough to
    // break the flow.
    setTimeout(() => { frozen = false; nextRound(); }, 1100);
    return;
  }

  await chrome.storage.local.set({ histoJeuRecord: best });
  $('game-again').hidden = false;
  frozen = false;
  round = null;
}

function nextRound() {
  round = drawRound();
  if (!round) {
    $('game-question').textContent = t('hist.game.nomore');
    $('game-cards').replaceChildren();
    $('game-again').hidden = false;
    return;
  }
  drawBoard();
}

async function newGame() {
  score = 0;
  frozen = false;
  nextRound();
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

export async function openGame() {
  const dlg = $('game-dialog');
  dlg.showModal();
  // `showModal()` gives focus to the first focusable element, here "Close": the
  // dialog opened with its exit control ringed, more visible than the two
  // channels to choose between. We keep the focus on the dialog itself.
  dlg.focus();
  $('game-question').textContent = t('hist.game.loading');
  $('game-cards').replaceChildren();
  $('game-verdict').textContent = '';
  $('game-again').hidden = true;

  const [list, stored] = await Promise.all([
    readDirectory(),
    chrome.storage.local.get('histoJeuRecord'),
  ]);
  best = stored?.histoJeuRecord ?? 0;

  // Two channels watched once each do not make a question: we keep only those
  // watched enough to have an intuition about, and we cap the list so the game
  // is about recognisable names.
  pool = list.filter((c) => c.count >= 3 && c.title).slice(0, 200);

  if (pool.length < 2) {
    $('game-question').textContent = t('hist.game.notenough');
    return;
  }
  await newGame();
}

export function wireGame(provideDirectory) {
  readDirectory = provideDirectory;
  $('game-close').addEventListener('click', () => $('game-dialog').close());
  $('game-again').addEventListener('click', () => newGame());
  $('game-dialog').addEventListener('click', (e) => {
    if (e.target === $('game-dialog')) $('game-dialog').close();
  });
}
