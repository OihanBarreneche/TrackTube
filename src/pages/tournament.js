/**
 * Tournament: the subjective ranking.
 *
 * The whole page measures what you watched. This tournament measures something
 * else: what you prefer. The two do not coincide, and that is exactly the point
 * — the channel opened four hundred times is not necessarily the one you would
 * save. No figure is shown during the duels, otherwise you would vote for the
 * ranking instead of voting for yourself; they appear afterwards, once the
 * choice is made.
 *
 * Single elimination, random draw. The final ranking is that of the round of
 * elimination: that is what a knockout bracket allows you to say, and nothing
 * more. Claiming to separate the four quarter finalists would be inventing a
 * result the duels did not produce.
 */

import { formatDuration } from '../lib/history.js';
import { t, bcp47 } from '../lib/i18n.js';

const $ = (id) => document.getElementById(id);
const number = (n) => new Intl.NumberFormat(bcp47()).format(n);

/** Supplied by the page: the directory already loaded for the search. */
let readDirectory = async () => [];

const state = {
  /** Sizes on offer, and the one chosen. */
  size: 16,
  pool: 'top',
  /** Contestants of the current round. @type {Array} */
  round: [],
  /** Winners of the current round, who will form the next one. */
  next: [],
  /** Index of the current duel within `round`, in steps of two. */
  duel: 0,
  /** Eliminated, from the first out to the last. `{channel, leftInRound}` */
  eliminated: [],
  /** Objective ranking, for the final comparison. @type {Map<string, number>} */
  realRank: new Map(),
  done: false,
};

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/** Fisher and Yates shuffle: the only one giving uniform permutations. */
function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * The contestants.
 *
 * The bracket demands a power of two: without it we would need byes, and a
 * contestant winning a round without playing skews the final ranking. So we
 * reduce the requested size to what the pool actually allows.
 *
 * Three pools, one of which draws nothing: `exact` takes the top of the ranking
 * as is. Asking for sixty four channels and seeing one watched three times turn
 * up is not the same wish as making your own top sixty four play, and the
 * randomness of the other two modes did not allow the second.
 */
function drawContestants(directory) {
  const known = directory.filter((c) => c.count >= 3 && c.title);

  const pool = {
    // A reserve wider than the bracket: the draw must have room to surprise,
    // otherwise "random" hands back the same line up every game.
    top: () => known.slice(0, Math.max(state.size * 3, 60)),
    exact: () => known.slice(0, state.size),
    toutes: () => known,
  }[state.pool]?.() ?? known;

  let size = Math.min(state.size, pool.length);
  // Largest power of two fitting in what we have.
  size = 2 ** Math.floor(Math.log2(Math.max(size, 1)));

  // The bracket stays shuffled even when the selection is not: otherwise the
  // first and second of the ranking would meet in the opening round.
  return shuffle(pool.slice(0, state.pool === 'exact' ? size : pool.length))
    .slice(0, size);
}

/** "Quarter finals", deduced from the number of contestants left. */
function roundName(left) {
  if (left <= 2) return t('hist.tour.r2');
  if (left <= 4) return t('hist.tour.r4');
  if (left <= 8) return t('hist.tour.r8');
  if (left <= 16) return t('hist.tour.r16');
  if (left <= 32) return t('hist.tour.r32');
  return t('hist.tour.rn', { n: left });
}

// ---------------------------------------------------------------------------
// Running the bracket
// ---------------------------------------------------------------------------

async function start() {
  const directory = await readDirectory();
  const contestants = drawContestants(directory);

  if (contestants.length < 2) {
    $('tournament-body').replaceChildren(Object.assign(document.createElement('p'), {
      className: 'muted',
      textContent: t('hist.tour.notenough'),
    }));
    return;
  }

  // The objective ranking is frozen at the draw: the directory is already
  // sorted by number of openings, we only need to keep everyone's position.
  state.realRank = new Map(directory.map((c, i) => [c.channelId, i + 1]));
  state.round = contestants;
  state.next = [];
  state.duel = 0;
  state.eliminated = [];
  state.done = false;
  drawDuel();
}

function vote(winner, loser) {
  state.next.push(winner);
  state.eliminated.push({ channel: loser, leftInRound: state.round.length });
  state.duel += 2;

  if (state.duel < state.round.length) { drawDuel(); return; }

  // Round over.
  if (state.next.length === 1) {
    state.eliminated.push({ channel: state.next[0], leftInRound: 1 });
    state.done = true;
    drawRanking();
    return;
  }

  state.round = state.next;
  state.next = [];
  state.duel = 0;
  drawDuel();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * The channel's picture, with the initial as a fallback rather than as the
 * other branch: a `yt3` address can have expired, and the broken image icon
 * read as a defect in the game.
 */
function avatarOf(c, cls = 'tournament-avatar') {
  const disc = document.createElement('span');
  disc.className = `${cls} tournament-avatar-initial`;
  disc.textContent = (c.title ?? '?').trim().charAt(0).toUpperCase() || '?';
  if (!c.avatarUrl) return disc;

  const img = document.createElement('img');
  img.className = cls;
  img.src = c.avatarUrl;
  img.alt = '';
  img.loading = 'lazy';
  img.addEventListener('error', () => img.replaceWith(disc), { once: true });
  return img;
}

function card(c, opponent) {
  const el = document.createElement('button');
  el.className = 'tournament-card';
  el.append(avatarOf(c));
  const name = document.createElement('b');
  name.textContent = c.title;
  el.append(name);
  el.addEventListener('click', () => vote(c, opponent));
  return el;
}

function drawDuel() {
  const a = state.round[state.duel];
  const b = state.round[state.duel + 1];

  const body = document.createElement('div');

  const header = document.createElement('p');
  header.className = 'tournament-round';
  header.textContent = t('hist.tour.duel', {
    round: roundName(state.round.length),
    i: state.duel / 2 + 1,
    n: state.round.length / 2,
  });
  body.append(header);

  const gauge = document.createElement('div');
  gauge.className = 'tournament-gauge';
  const bar = document.createElement('i');
  bar.style.width = `${(state.duel / state.round.length) * 100}%`;
  gauge.append(bar);
  body.append(gauge);

  const question = document.createElement('p');
  question.className = 'tournament-question';
  question.textContent = t('hist.tour.question');
  body.append(question);

  const pair = document.createElement('div');
  pair.className = 'tournament-pair';
  pair.append(card(a, b), card(b, a));
  body.append(pair);

  $('tournament-body').replaceChildren(body);
}

/**
 * The final ranking, and what it says about the other one.
 *
 * The eliminated are stacked from the first out to the last, so read backwards
 * they give the order of the podium. Ties are owned: four channels knocked out
 * in the quarter finals are level, and inventing an order for them would be
 * lying.
 */
function drawRanking() {
  const body = document.createElement('div');
  body.className = 'tournoi-fin';

  const ranking = state.eliminated.slice().reverse();
  const champion = ranking[0].channel;

  const title = document.createElement('p');
  title.className = 'tournament-round';
  title.textContent = t('hist.tour.ranking');
  body.append(title);

  const podium = document.createElement('div');
  podium.className = 'tournament-winner';
  podium.append(avatarOf(champion, 'tournament-avatar large'));
  const name = document.createElement('b');
  name.textContent = champion.title;
  const sub = document.createElement('span');
  sub.className = 'muted';
  sub.textContent = t('hist.nvideos', { n: number(champion.count) })
    + (champion.seconds ? ` · ${formatDuration(Math.round(champion.seconds))}` : '');
  podium.append(name, sub);
  body.append(podium);

  const table = document.createElement('table');
  table.className = 'tournament-ranking';
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr><th>${t('hist.tour.th.rank')}</th>`
    + `<th>${t('hist.tour.th.channel')}</th><th>${t('hist.tour.th.out')}</th>`
    + `<th class="num">${t('hist.tour.th.real')}</th></tr>`;
  table.append(thead);

  // Ties: everything knocked out in the same round shares the same rank, and
  // the mention is carried by every line of the group. Putting it only on the
  // second would suggest the first had been separated out.
  const groupSizes = new Map();
  for (const e of ranking) groupSizes.set(e.leftInRound, (groupSizes.get(e.leftInRound) ?? 0) + 1);

  const tbody = document.createElement('tbody');
  let rank = 0;
  let previous = null;
  ranking.forEach((e, i) => {
    if (e.leftInRound !== previous) { rank = i + 1; previous = e.leftInRound; }

    const tr = document.createElement('tr');
    const rankCell = document.createElement('td');
    rankCell.textContent = groupSizes.get(e.leftInRound) > 1
      ? t('hist.tour.tied', { n: rank })
      : String(rank);

    const nameCell = document.createElement('td');
    const link = document.createElement('a');
    link.href = `#chaine=${e.channel.channelId}`;
    link.textContent = e.channel.title;
    nameCell.append(link);

    const roundCell = document.createElement('td');
    roundCell.className = 'muted';
    roundCell.textContent = e.leftInRound === 1
      ? t('hist.tour.winner')
      : roundName(e.leftInRound);

    const realCell = document.createElement('td');
    realCell.className = 'num muted';
    const real = state.realRank.get(e.channel.channelId);
    realCell.textContent = real ? t('hist.tour.nth', { n: real }) : '—';

    tr.append(rankCell, nameCell, roundCell, realCell);
    tbody.append(tr);
  });
  table.append(tbody);
  body.append(table);

  body.append(Object.assign(document.createElement('p'), {
    className: 'muted tournament-note',
    textContent: t('hist.tour.note'),
  }));

  $('tournament-body').replaceChildren(body);
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

function drawSettings() {
  const body = document.createElement('div');
  body.className = 'tournament-settings';

  body.append(Object.assign(document.createElement('p'), {
    className: 'muted',
    textContent: t('hist.tour.intro'),
  }));

  const row = (label, options, key) => {
    const l = document.createElement('div');
    l.className = 'tournament-row';
    l.append(Object.assign(document.createElement('span'), { textContent: label }));
    const seg = document.createElement('div');
    seg.className = 'segmented';
    for (const [value, text] of options) {
      const b = document.createElement('button');
      b.textContent = text;
      if (state[key] === value) b.className = 'is-active';
      b.addEventListener('click', () => { state[key] = value; drawSettings(); });
      seg.append(b);
    }
    l.append(seg);
    return l;
  };

  body.append(row(t('hist.tour.size'),
    [[8, '8'], [16, '16'], [32, '32'], [64, '64'], [128, '128']], 'size'));
  body.append(row(t('hist.tour.pool'), [
    ['top', t('hist.tour.pool.top')],
    ['exact', t('hist.tour.pool.exact', { n: state.size })],
    ['toutes', t('hist.tour.pool.all')],
  ], 'pool'));

  const launch = document.createElement('button');
  launch.className = 'button primary';
  launch.textContent = t('hist.tour.start');
  launch.addEventListener('click', () => start());
  body.append(launch);

  $('tournament-body').replaceChildren(body);
}

export function openTournament() {
  $('tournament-dialog').showModal();
  $('tournament-dialog').focus();
  drawSettings();
}

export function wireTournament(provideDirectory) {
  readDirectory = provideDirectory;
  $('tournament-close').addEventListener('click', () => $('tournament-dialog').close());
  $('tournament-again').addEventListener('click', () => drawSettings());
  $('tournament-dialog').addEventListener('click', (e) => {
    if (e.target === $('tournament-dialog')) $('tournament-dialog').close();
  });
  // A channel link in the ranking leads to its record: the dialog has to step
  // aside, otherwise the record opens behind a modal.
  $('tournament-body').addEventListener('click', (e) => {
    if (e.target.closest('a')) $('tournament-dialog').close();
  });
}
