/**
 * Regression tests on pure logic: the IndexedDB layer and the scheduler. No
 * network, no extension API.
 *
 * Running them: see test/README.md (an HTTP server is needed, ES modules do not
 * load from file://).
 *
 * What is covered here is precisely what cannot be seen with the naked eye: the
 * paging when several videos share the same publication date, and the
 * scheduler's thresholds.
 */

import * as db from '../src/lib/db.js';
import * as sch from '../src/background/scheduler.js';
import { parseAtomFeed, feedFingerprint, feedUrl, uploadsPlaylistId } from '../src/lib/rss.js';
import { parseSubscriptionsCsv, planApplication, MODES } from '../src/lib/subscriptions-csv.js';
import { FEED_PAGE_OPTIONS, pick, destructuredParamNames } from '../src/lib/feed-options.js';
import * as tri from '../src/lib/triage-order.js';
import * as itp from '../src/lib/innertube-parse.js';
import { decodeEntities, parseCompactCount, videoIncomplete } from '../src/lib/util.js';
import * as hist from '../src/lib/history.js';
import { accountKey, sameAccount } from '../src/lib/account.js';
import { fr } from '../src/lib/locales/fr.js';
import { en } from '../src/lib/locales/en.js';
import { t, setLocale, getLocale, LOCALES } from '../src/lib/i18n.js';
import { runReverseAudit } from '../src/background/audit.js';
import { formatReverseAuditReport } from '../src/lib/audit-format.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

export async function run() {
  const results = [];
  const check = (name, cond, extra) =>
    results.push({ name, pass: Boolean(cond), extra });

  await resetDatabase();

  await testChannels(check);
  await testVideos(check);
  await testPagination(check);
  await testHiding(check);
  await testUnseenFilter(check);
  await testSearchAndCounts(check);
  await testChannelOperations(check);
  await testStarring(check);
  await testComfortFilters(check);
  await testUpcoming(check);
  await testBackup(check);
  await testNativeHarvestIsolation(check);
  await testWatchSessions(check);
  await testStrictComplete(check);
  await testVideosInconnues(check);
  await testHistoriqueRecupere(check);
  await testJournalDuJour(check);
  await testReverseAudit(check);
  testManiereDeRegarder(check);
  testInnertubeParse(check);
  testCompte(check);
  testScheduler(check);
  testRss(check);
  testSubscriptionsCsv(check);
  testPlanApplication(check);
  testFeedOptionsContract(check);
  testTriageOrder(check);
  testAccroches(check);
  testHistory(check);
  testI18n(check);

  return results;
}

async function testReverseAudit(check) {
  const now = Date.now();
  const base = {
    channelId: channelId(1), channelTitle: 'Chaîne audit',
    publishedAt: now - HOUR, thumbUrl: 'https://example/audit.jpg', views: 10,
  };
  await db.upsertVideos([
    { ...base, id: 'auditvis001', title: 'Visible', durationSec: 600 },
    { ...base, id: 'audithid001', title: 'Masquée', durationSec: 600 },
    { ...base, id: 'auditflt001', title: 'Filtrée', durationSec: 60 },
  ]);
  await db.setHidden(['audithid001'], true);
  await db.recordVideoClassification('auditshr001', true, now);

  const recorded = await db.recordNativeVideos([
    { ...base, id: 'auditvis001', title: 'Visible' },
    { ...base, id: 'audithid001', title: 'Masquée' },
    { ...base, id: 'auditflt001', title: 'Filtrée' },
    { ...base, id: 'auditmis001', title: 'Absente' },
    { ...base, id: 'auditshr001', title: 'Short' },
    { id: 'auditnod001', title: 'Sans date' },
  ], now);
  check('audit inverse : toutes les observations restent hors du feed',
    recorded.count === 6 && recorded.inserted === 6, recorded);

  const report = await runReverseAudit({ windowDays: 1, source: { coveredWindow: true } });
  check('audit inverse : toute ligne TrackTube compte, quel que soit son affichage',
    report.ok && report.total === 5 && report.presentCount === 3
      && report.excludedShortsCount === 1 && report.missingCount === 1,
    report);
  check('audit inverse : une ligne sans date est exclue du verdict temporel',
    report.undatedCount === 1 && !report.missing.some((video) => video.id === 'auditnod001'), report);

  const rendered = formatReverseAuditReport(report);
  check('audit inverse : le rapport donne le lien exact de la vidéo manquante',
    rendered.includes('https://www.youtube.com/watch?v=auditmis001'), rendered);

  await testAuditHorsListe(check, now, base);

  await db.recordNativeVideos([{ ...base, id: 'auditnew001', title: 'Nouvelle mesure' }], now, {
    replace: true,
  });
  const replaced = await db.getNativeVideosSince(now - DAY);
  check('audit inverse : une lecture directe remplace la mesure précédente',
    replaced.videos.length === 1 && replaced.videos[0].id === 'auditnew001'
      && replaced.undated.length === 0,
    replaced);
  await db.recordNativeVideos([], now, { replace: true });
  const emptyReplacement = await db.getNativeVideosSince(now - DAY);
  check('audit inverse : une source vide efface les observations précédentes',
    emptyReplacement.videos.length === 0 && emptyReplacement.undated.length === 0, emptyReplacement);
}

/**
 * What the headline figure of the reverse audit may and may not count.
 *
 * Written after a real run on 8 October 2026 announced two videos missed, one
 * of which came from a channel whose presence in the subscription list the
 * report could not state either way. The figure has to mean one thing only:
 * videos from channels TrackTube is actually sweeping. Everything else is kept
 * and named, because an unfollowed channel is either YouTube recommending
 * something — the behaviour this extension exists to escape — or a subscription
 * the import lost, which is worse than the video.
 */
async function testAuditHorsListe(check, now, base) {
  const suivie = channelId(1);
  const retiree = channelId(30);
  const inconnue = channelId(31);

  // Added without the completeness flag, so nothing else is deactivated, then
  // taken out of the sweep by hand: that is the state a reconciliation leaves.
  await db.reconcileChannels([{ id: retiree, title: 'Retirée du balayage' }]);
  const horsBalayage = await db.getChannel(retiree);
  await db.putChannel({ ...horsBalayage, active: 0 });

  await db.recordNativeVideos([
    { ...base, id: 'auditown001', title: 'Chaîne suivie', channelId: suivie },
    { ...base, id: 'auditoff001', title: 'Recommandation', channelId: inconnue,
      channelTitle: 'Chaîne jamais importée' },
    { ...base, id: 'auditina001', title: 'Chaîne désactivée', channelId: retiree,
      channelTitle: 'Retirée du balayage' },
    { ...base, id: 'auditanon01', title: 'Sans propriétaire', channelId: '' },
  ], now, { replace: true });

  const r = await runReverseAudit({ windowDays: 1, source: { coveredWindow: true } });
  check('audit inverse : seule la chaîne suivie compte comme ratée',
    r.missingCount === 1 && r.missing[0].id === 'auditown001', r.missing);
  check('audit inverse : une chaîne hors liste est comptée à part, pas en ratée',
    r.missingUnfollowedCount === 1
    && r.unfollowedChannels[0].title === 'Chaîne jamais importée', r.unfollowedChannels);
  check('audit inverse : une chaîne désactivée est signalée pour elle même',
    r.missingInactiveCount === 1 && r.inactiveChannels[0].channelId === retiree, r.inactiveChannels);
  check('audit inverse : une carte sans propriétaire ne condamne personne',
    r.missingUnattributedCount === 1, r);
  check('audit inverse : le total des observations reste entier',
    r.total === 4 && r.presentCount === 0, r);

  const texte = formatReverseAuditReport(r);
  check('audit inverse : le rapport nomme la chaîne hors liste',
    texte.includes('Chaîne jamais importée') && texte.includes('Retirée du balayage'), texte);
  check('audit inverse : le rapport ne range pas ces vidéos sous les ratées',
    !texte.includes('auditoff001') && !texte.includes('auditina001'), texte);

  // Left as it was found: the suites share one database.
  await db.recordNativeVideos([], now, { replace: true });
}

/**
 * Translation catalogues.
 *
 * The real risk is not a mistranslation, it is the key added on one side only:
 * it breaks nothing, the fallback on French is silent, and the interface stays
 * half translated until somebody notices.
 */
function testI18n(check) {
  const clesFr = Object.keys(fr).sort();
  const clesEn = Object.keys(en).sort();

  const manquantesEn = clesFr.filter((k) => !(k in en));
  const manquantesFr = clesEn.filter((k) => !(k in fr));
  check('i18n : aucune clé française sans traduction anglaise',
    manquantesEn.length === 0, manquantesEn);
  check('i18n : aucune clé anglaise sans équivalent français',
    manquantesFr.length === 0, manquantesFr);

  // A plural on one side and a plain string on the other would pass the key
  // check while producing "3 video" in one language and not in the other.
  const formesDivergentes = clesFr.filter((k) => (typeof fr[k] === 'object') !== (typeof en[k] === 'object'));
  check('i18n : les pluriels sont déclarés des deux côtés',
    formesDivergentes.length === 0, formesDivergentes);

  // The substituted parameters have to be the same: a `{name}` forgotten in
  // English shows as it is in the interface.
  const params = (v) => [...String(typeof v === 'object' ? Object.values(v).join(' ') : v)
    .matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  const parametresDivergents = clesFr.filter((k) => params(fr[k]) !== params(en[k]));
  check('i18n : les mêmes paramètres des deux côtés',
    parametresDivergents.length === 0, parametresDivergents);

  setLocale('fr');
  check('i18n : substitution des paramètres',
    t('menu.channel.videos', { name: 'Arte' }) === 'Voir toutes les vidéos de Arte',
    t('menu.channel.videos', { name: 'Arte' }));
  check('i18n : en français, zéro prend le singulier',
    t('toast.starred', { n: 0 }) === '0 vidéo mise en priorité', t('toast.starred', { n: 0 }));
  check('i18n : et deux prend le pluriel',
    t('toast.starred', { n: 2 }) === '2 vidéos mises en priorité', t('toast.starred', { n: 2 }));

  setLocale('en');
  check('i18n : la langue choisie change le rendu',
    t('feed.view.hidden') === 'Hidden', t('feed.view.hidden'));
  check('i18n : en anglais, zéro prend le pluriel',
    t('toast.starred', { n: 0 }) === '0 videos marked as priority', t('toast.starred', { n: 0 }));

  setLocale('kl');
  check('i18n : une langue inconnue retombe sur une langue connue',
    LOCALES.includes(getLocale()), getLocale());

  setLocale('fr');
  check('i18n : une clé inconnue se rend elle-même',
    t('cette.cle.n.existe.pas') === 'cette.cle.n.existe.pas');
}

/** Takeout history: reading the file, and statistics. */
function testHistory(check) {
  const T = (iso) => Date.parse(iso);
  const brut = [
    { header: 'YouTube', title: 'Vous avez regardé Une vidéo utile',
      titleUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
      subtitles: [{ name: 'Chaîne A', url: 'https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa' }],
      time: '2026-08-10T20:30:00.000Z' },
    { header: 'YouTube', title: 'Vous avez regardé Une autre',
      titleUrl: 'https://www.youtube.com/watch?v=bbbbbbbbbbb',
      subtitles: [{ name: 'Chaîne A', url: 'https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa' }],
      time: '2026-08-10T21:00:00.000Z' },
    { header: 'YouTube', title: 'Vous avez regardé Chez B',
      titleUrl: 'https://www.youtube.com/watch?v=ccccccccccc',
      subtitles: [{ name: 'Chaîne B', url: 'https://www.youtube.com/channel/UCbbbbbbbbbbbbbbbbbbbbbb' }],
      time: '2026-01-02T09:00:00.000Z' },
    // Deleted video: no URL any more, hence nothing usable. To be counted apart.
    { header: 'YouTube', title: 'Vous avez regardé une vidéo qui a été supprimée',
      time: '2026-08-01T10:00:00.000Z' },
    // A search, if the user has exported both histories.
    { header: 'YouTube', title: 'Vous avez recherché rust async',
      titleUrl: 'https://www.youtube.com/results?search_query=rust+async',
      time: '2026-08-01T10:05:00.000Z' },
    { rien: 'du tout' },
  ];

  // A case found on a real export: when Google can no longer resolve the video,
  // it puts the URL in place of the title and names no channel. On a real
  // history, these entries were numerous enough — five hundred and fifty four —
  // to form an "unknown channel" at the top of the ranking, ahead of the
  // channels actually watched most.
  brut.push({
    header: 'YouTube',
    title: 'Vous avez regardé https://www.youtube.com/watch?v=ddddddddddd',
    titleUrl: 'https://www.youtube.com/watch?v=ddddddddddd',
    time: '2026-08-10T22:00:00.000Z',
  });

  const { entries, deleted, ignored, unresolved } = hist.parseWatchHistory(brut);
  check('historique : une vidéo devenue indisponible est repérée',
    unresolved === 1, unresolved);
  check('historique : elle reste comptée comme un visionnage',
    entries.some((e) => e.videoId === 'ddddddddddd'), entries.length);

  const avecOrpheline = hist.computeStats(entries);
  check('stats : aucune chaîne fantôme ne se crée',
    !avecOrpheline.topChannels.some((c) => c.title === 'Chaîne inconnue'),
    avecOrpheline.topChannels.map((c) => c.title));
  check('stats : les indisponibles sont comptées à part',
    avecOrpheline.unresolved === 1, avecOrpheline.unresolved);
  check('stats : et restent dans le total',
    avecOrpheline.total === 4, avecOrpheline.total);

  brut.pop();
  const { entries: propres } = hist.parseWatchHistory(brut);
  check('historique : seuls les visionnages exploitables sont retenus',
    propres.length === 3, propres.length);
  check('historique : les vidéos supprimées sont comptées à part',
    deleted === 1, deleted);
  check('historique : les recherches et le bruit sont écartés',
    ignored === 2, ignored);

  // The "You watched" prefix is not the video's title.
  check('historique : le titre est débarrassé du préfixe',
    propres[0].title === 'Une vidéo utile', propres[0].title);
  check('historique : l’identifiant de chaîne est extrait de l’URL',
    propres[0].channelId === 'UCaaaaaaaaaaaaaaaaaaaaaa', propres[0].channelId);

  check('historique : un tableau est exigé', (() => {
    try { hist.parseWatchHistory({ pas: 'un tableau' }); return false; } catch { return true; }
  })());

  // -- statistiques
  const durations = new Map([['aaaaaaaaaaa', 600], ['bbbbbbbbbbb', 1200]]);
  const stats = hist.computeStats(propres, { from: T('2026-08-01T00:00:00Z'), to: T('2026-08-31T00:00:00Z'), durations });

  check('stats : la plage exclut ce qui est hors bornes', stats.total === 2, stats.total);
  check('stats : les chaînes sont regroupées', stats.distinctChannels === 1, stats.distinctChannels);
  check('stats : le temps exact ne compte que les durées connues',
    stats.exactSeconds === 1800, stats.exactSeconds);

  // The channel's mean replaces the exact duration when it is missing, and it
  // alone: an overall mean would mix unrelated formats. The fixture has two
  // channels; only A is enriched, so B's video stays without a duration rather
  // than inherit a mean that is not its own.
  const avecMoyenne = hist.computeStats(propres, {
    durations: new Map([['aaaaaaaaaaa', 600]]),
    channelMeans: new Map([['UCaaaaaaaaaaaaaaaaaaaaaa', 900]]),
  });
  check('stats : la moyenne de chaîne comble les durées manquantes',
    avecMoyenne.estimatedSeconds === 900, avecMoyenne.estimatedSeconds);
  check('stats : exact et estimé restent séparés',
    avecMoyenne.exactSeconds === 600 && avecMoyenne.totalSeconds === 1500,
    [avecMoyenne.exactSeconds, avecMoyenne.totalSeconds]);
  check('stats : une chaîne non enrichie n’hérite pas de la moyenne d’une autre',
    avecMoyenne.withoutDuration === 1, avecMoyenne.withoutDuration);

  // With no known duration at all, better to show nothing than to invent.
  const sansDuree = hist.computeStats(propres, { durations: new Map() });
  check('stats : sans durée connue, aucun temps n’est produit',
    sansDuree.totalSeconds === 0, sansDuree.totalSeconds);
  check('stats : le comptage de vidéos reste juste sans durées',
    sansDuree.total === 3, sansDuree.total);
  check('stats : les vidéos sans durée sont dénombrées',
    sansDuree.withoutDuration === 3, sansDuree.withoutDuration);

  // -- time actually watched
  //
  // Two measurements live in the same range: the duration of the content opened,
  // which holds for the whole history, and the time actually spent, which only
  // exists on the sessions the extension has read. They must never be mixed — a
  // total adding the two would measure nothing.
  const mesurees = propres.map((e, i) => (i === 0 ? { ...e, watchedSec: 120 } : e));
  const mixte = hist.computeStats(mesurees, { durations });
  check('temps regardé : seules les séances mesurées comptent',
    mixte.watchedSeconds === 120, mixte.watchedSeconds);
  check('temps regardé : les ouvertures mesurées sont dénombrées',
    mixte.measuredOpens === 1, mixte.measuredOpens);
  check('temps regardé : la durée du contenu reste calculée à part',
    mixte.exactSeconds === hist.computeStats(propres, { durations }).exactSeconds,
    mixte.exactSeconds);
  check('temps regardé : un historique sans mesure rend zéro',
    hist.computeStats(propres, { durations }).measuredOpens === 0);

  // A reopened video counts its content time once only, but two measured
  // sessions really are twice the time spent in front of the screen.
  const rouverte = [
    { ...propres[0], watchedAt: T('2026-08-02T10:00:00Z'), watchedSec: 100 },
    { ...propres[0], watchedAt: T('2026-08-02T14:00:00Z'), watchedSec: 60 },
  ];
  const deuxFois = hist.computeStats(rouverte, { durations });
  check('temps regardé : deux séances sur la même vidéo s’additionnent',
    deuxFois.watchedSeconds === 160, deuxFois.watchedSeconds);
  check('temps regardé : la durée du contenu, elle, ne double pas',
    deuxFois.exactSeconds === 600, deuxFois.exactSeconds);

  // -- the default model, mixed
  //
  // What was measured is worth what it measured; a video no opening of which was
  // measured is worth its length, once; nothing is ever worth both. The bug this
  // closes: a week the extension had measured almost entirely showed eleven hours
  // a day, because collecting the YouTube history page pushed the range under the
  // threshold below and every video went back to counting its full length.
  const toutesMesurees = propres.map((e) => ({ ...e, watchedSec: 120 }));
  check('mixte : le total additionne le mesuré et la durée du reste',
    mixte.timeMode === 'mixed' && mixte.totalSeconds === 1320,
    [mixte.timeMode, mixte.totalSeconds]);
  check('mixte : la vidéo mesurée n’est pas recomptée à sa durée',
    mixte.extraSeconds === 1200 && mixte.extraVideos === 1,
    [mixte.extraSeconds, mixte.extraVideos]);
  const toutMesure = hist.computeStats(toutesMesurees, { durations });
  check('mixte : tout mesuré, plus rien n’est ajouté',
    toutMesure.extraSeconds === 0 && toutMesure.totalSeconds === 360,
    [toutMesure.extraSeconds, toutMesure.totalSeconds]);
  check('mixte : deux séances sur la même vidéo comptent deux fois, sa durée zéro',
    hist.computeStats(rouverte, { durations }).totalSeconds === 160,
    hist.computeStats(rouverte, { durations }).totalSeconds);

  // -- where the viewings came from
  //
  // This is what answers "what could not be traced": a line with no clock will
  // never carry a measurement, whatever happens later.
  check('sources : chaque ligne est classée par sa provenance',
    JSON.stringify(hist.computeStats([
      { ...propres[0], source: 'live', watchedSec: 30 },
      { ...propres[1], source: 'yt' },
      { ...propres[2] },
    ], { durations }).bySource) === '{"live":1,"takeout":1,"yt":1}',
    hist.computeStats(propres, { durations }).bySource);

  // -- the other model, one single unit
  //
  // The earlier behaviour, kept as a setting. As long as the reading does not
  // cover nearly the whole range, everything is counted the Takeout way: each
  // opening is worth its video's whole duration. Mixing measured channels with
  // channels assumed watched in full would make the ranking incomparable with
  // itself.
  const uniforme = hist.computeStats(mesurees, { durations, timeModel: 'auto' });
  check('bascule : une plage à peine mesurée reste sur la durée du contenu',
    uniforme.timeMode === 'content' && uniforme.totalSeconds === uniforme.contentSeconds,
    [uniforme.timeMode, uniforme.measuredCoverage]);
  check('bascule : la couverture est le rapport des ouvertures mesurées',
    Math.abs(mixte.measuredCoverage - 1 / 3) < 1e-9, mixte.measuredCoverage);

  const reel = hist.computeStats(toutesMesurees, { durations, timeModel: 'auto' });
  check('bascule : une plage entièrement mesurée passe au temps réel',
    reel.timeMode === 'real' && reel.totalSeconds === 360,
    [reel.timeMode, reel.totalSeconds]);
  check('bascule : la durée du contenu reste disponible pour comparaison',
    reel.contentSeconds === 1800, reel.contentSeconds);
  check('bascule : le seuil est celui annoncé',
    hist.REAL_TIME_THRESHOLD === 0.9, hist.REAL_TIME_THRESHOLD);
  check('bascule : le seuil est réglable',
    hist.computeStats(mesurees, { durations, timeModel: 'auto', realThreshold: 0.3 })
      .timeMode === 'real');
  check('bascule : le modèle mixte ignore le seuil',
    hist.computeStats(mesurees, { durations, realThreshold: 0.01 }).timeMode === 'mixed');

  // Share of the video actually watched. It is weighted by duration: the mean
  // of the percentages would give a clip as much weight as a film. The
  // denominator keeps only the openings whose duration is known — the third
  // video has none, so it does not skew the ratio.
  check('part vue : rapportée à la durée des seules vidéos mesurées',
    Math.abs(reel.meanWatchedShare - 360 / 1800) < 1e-9, reel.meanWatchedShare);
  check('part vue : sans aucune mesure, elle est nulle et non zéro',
    hist.computeStats(propres, { durations }).meanWatchedShare === null);
  const mesureeA = reel.topChannels.find((c) => c.title === 'Chaîne A');
  check('part vue : chaque chaîne a la sienne',
    Math.abs(mesureeA.watchedShare - 240 / 1800) < 1e-9, mesureeA?.watchedShare);
  const nonMesuree = mixte.topChannels.find((c) => c.title === 'Chaîne B');
  check('part vue : une chaîne jamais mesurée n’en a pas',
    nonMesuree.watchedShare === null, nonMesuree?.watchedShare);

  // A session on a video since made unavailable is still time spent: attaching
  // it to a channel fails, the measurement does not.
  const orpheline = hist.computeStats(
    [{ ...propres[0], nonResolue: true, watchedSec: 45 }], { durations });
  check('temps regardé : une vidéo non résolue garde son temps mesuré',
    orpheline.watchedSeconds === 45, orpheline.watchedSeconds);

  // -- a channel's mean duration
  //
  // The mean of the uploads answers a different question from the one asked: a
  // channel publishing a hundred Shorts and twenty documentaries has an upload
  // mean of a few minutes when one has only watched the documentaries. That is
  // what made nine minutes be announced on a channel where no video watched came
  // under half an hour.
  {
    const vus = [
      { videoId: 'long1', watchedAt: 1000, title: 'x', channelId: 'UCa', channelTitle: 'A' },
      { videoId: 'long2', watchedAt: 2000, title: 'x', channelId: 'UCa', channelTitle: 'A' },
      { videoId: 'long3', watchedAt: 3000, title: 'x', channelId: 'UCa', channelTitle: 'A' },
      { videoId: 'inconnue', watchedAt: 4000, title: 'x', channelId: 'UCa', channelTitle: 'A' },
    ];
    const connues = new Map([['long1', 2400], ['long2', 3600], ['long3', 1800]]);
    const uploads = new Map([['UCa', 540]]); // la moyenne Shorts compris

    const affinees = hist.refineChannelMeans(vus, connues, uploads);
    check('moyenne : ce qu’on a regardé prime sur la moyenne des uploads',
      affinees.get('UCa') === 2600, affinees.get('UCa'));

    // A single known duration does not describe a habit: a long form watched by
    // chance on a clip channel would give an absurd mean.
    const maigre = hist.refineChannelMeans(vus.slice(0, 1), connues, uploads);
    check('moyenne : sous le seuil d’échantillon, la moyenne des uploads reste',
      maigre.get('UCa') === 540, maigre.get('UCa'));
    check('moyenne : le seuil est celui annoncé',
      hist.MIN_MEAN_SAMPLE === 3, hist.MIN_MEAN_SAMPLE);

    // A reopened video does not weigh twice in the mean.
    const rouverte = hist.refineChannelMeans(
      [...vus, { ...vus[0], watchedAt: 9000 }], connues, uploads);
    check('moyenne : une vidéo rouverte ne compte qu’une fois',
      rouverte.get('UCa') === 2600, rouverte.get('UCa'));

    // And it does serve to estimate the video whose duration is missing.
    const s = hist.computeStats(vus, { durations: connues, channelMeans: affinees });
    check('moyenne : l’estimation d’une vidéo inconnue suit la moyenne affinée',
      s.estimatedSeconds === 2600, s.estimatedSeconds);

    // A channel about which nothing is known keeps its fallback, and a channel
    // absent from both the fallback and the durations stays without a mean rather
    // than have one invented.
    check('moyenne : une chaîne sans repli ni durée connue n’en reçoit pas',
      hist.refineChannelMeans(vus, new Map(), new Map()).get('UCa') === undefined);
  }

  check('stats : les jours actifs sont dédupliqués',
    hist.computeStats(propres).activeDays === 2, hist.computeStats(propres).activeDays);

  // -- exclusions
  const masquee = hist.computeStats(propres, { blacklist: new Set(['UCaaaaaaaaaaaaaaaaaaaaaa']) });
  check('stats : une chaîne masquée disparaît des totaux',
    masquee.total === 1 && masquee.distinctChannels === 1, [masquee.total, masquee.distinctChannels]);
  check('stats : les autres chaînes restent intactes',
    masquee.topChannels[0].title === 'Chaîne B', masquee.topChannels[0]?.title);
  // An export does not always give the id: without falling back on the name, a
  // channel left anonymous would be impossible to hide.
  check('stats : masquer par nom marche aussi',
    hist.computeStats(propres, { blacklist: new Set(['Chaîne A']) }).total === 1);
  check('stats : une vidéo exclue ne compte plus',
    hist.computeStats(propres, { excludedVideos: new Set(['aaaaaaaaaaa']) }).total === 2);

  // `formatDuration` goes through the catalogue: the labels below are the
  // French ones, and `testI18n` may have left the language on English.
  setLocale('fr');
  check('durée : 9315 s → « 2 h 35 »', hist.formatDuration(9315) === '2 h 35', hist.formatDuration(9315));
  check('durée : moins d’une heure en minutes', hist.formatDuration(600) === '10 min', hist.formatDuration(600));
  check('durée : heure pleine sans minutes', hist.formatDuration(7200) === '2 h', hist.formatDuration(7200));
  // Past a hundred hours, the minute adds nothing and the thousands separator
  // becomes indispensable: "7020 h" cannot be read. The French separator is a
  // narrow no break space, hence the comparison on the shape.
  check('durée : au-delà de cent heures, milliers séparés et minutes tombées',
    /^7\s020\sh$/u.test(hist.formatDuration(7020 * 3600 + 1800)),
    hist.formatDuration(7020 * 3600 + 1800));

  check('plage : « tout » ne borne pas', hist.rangeBounds('tout').from === 0);
  check('plage : « 7j » borne à sept jours',
    Math.round((Date.now() - hist.rangeBounds('7j').from) / 86_400_000) === 7);

  // A calendar year runs from 1 January to 31 December, not over twelve rolling
  // months: the two families of ranges answer different questions and must not
  // be confused.
  const an = hist.rangeBounds('2025');
  check('plage : une année civile commence au 1er janvier',
    new Date(an.from).getFullYear() === 2025 && new Date(an.from).getMonth() === 0,
    new Date(an.from).toISOString());
  check('plage : et finit au 31 décembre',
    new Date(an.to).getFullYear() === 2025 && new Date(an.to).getMonth() === 11,
    new Date(an.to).toISOString());

  const prec = hist.previousRange({ from: 1000, to: 2000 });
  check('plage : la période précédente a la même durée et ne chevauche pas',
    prec.to === 999 && prec.to - prec.from === 1000, prec);

  check('variation : +50 % correctement calculé', hist.variation(15, 10) === 0.5);
  check('variation : sans période précédente, rien à comparer',
    hist.variation(15, 0) === null);

  check('années couvertes : de la plus récente à la plus ancienne',
    JSON.stringify(hist.coveredYears(T('2024-03-01T00:00:00Z'), T('2026-02-01T00:00:00Z')))
      === '[2026,2025,2024]');

  testSaturationTemps(check);
  testMoyennes(check);
  testSessions(check);
  testConcentration(check);
  testAbonnements(check);
  testSerieQuotidienne(check);
  testFicheChaine(check);
  testVideosParTerme(check);
  testAnnuaire(check);
  testAutoOpened(check);
  testStreaks(check);
  testThemes(check);
  testSujets(check);
}

/**
 * A video's time does not add up at every opening.
 *
 * The history does not tell a real rewatch from a reopened tab. Without this
 * saturation, a two hour video opened three times would weigh six hours and
 * would tip its channel's ranking on its own.
 */
function testSaturationTemps(check) {
  const JOUR = 86_400_000;
  const base = Date.parse('2026-05-01T10:00:00Z');
  const entries = [];
  for (let i = 0; i < 3; i++) {
    entries.push({
      videoId: 'longue00000', watchedAt: base + i * JOUR,
      title: 'Podcast', channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa', channelTitle: 'A',
    });
  }
  entries.push({
    videoId: 'courte00000', watchedAt: base,
    title: 'Court', channelId: 'UCbbbbbbbbbbbbbbbbbbbbbb', channelTitle: 'B',
  });

  const s = hist.computeStats(entries, {
    durations: new Map([['longue00000', 7200], ['courte00000', 600]]),
  });

  check('saturation : une vidéo rouverte ne compte son temps qu’une fois',
    s.totalSeconds === 7800, s.totalSeconds);
  check('saturation : les ouvertures restent comptées intégralement',
    s.total === 4, s.total);
  check('saturation : la couverture se rapporte aux vidéos distinctes',
    s.countedVideos === 2 && s.withExactDuration === 2, [s.countedVideos, s.withExactDuration]);

  const a = s.topChannels.find((c) => c.title === 'A');
  check('saturation : la chaîne ne cumule pas trois fois la même vidéo',
    a.seconds === 7200, a.seconds);
  // The figure shown under "Videos" counts videos. Counting the openings there
  // showed twenty two videos for a channel that has ten, next to a time
  // computed over the ten — the two numbers contradicted each other.
  check('saturation : la chaîne compte une vidéo distincte, pas trois ouvertures',
    a.count === 1, a.count);
  check('saturation : les ouvertures restent comptées à part',
    a.opens === 3, a.opens);
}

/**
 * Means per day, per active day and per week.
 *
 * The three denominators are distinct and confusing them would be misleading:
 * four videos over two active days inside a four day range make two videos per
 * active day but only one per day of the range.
 */
function testMoyennes(check) {
  const J = (iso) => Date.parse(iso);
  const entries = [
    { videoId: 'v1', watchedAt: J('2026-03-02T10:00:00'), title: 'x', channelId: 'UCa', channelTitle: 'A' },
    { videoId: 'v2', watchedAt: J('2026-03-02T11:00:00'), title: 'x', channelId: 'UCa', channelTitle: 'A' },
    { videoId: 'v3', watchedAt: J('2026-03-02T12:00:00'), title: 'x', channelId: 'UCb', channelTitle: 'B' },
    { videoId: 'v4', watchedAt: J('2026-03-04T10:00:00'), title: 'x', channelId: 'UCa', channelTitle: 'A' },
  ];
  const s = hist.computeStats(entries, {
    from: J('2026-03-02T00:00:00'), to: J('2026-03-05T23:59:59'),
    durations: new Map([['v1', 600], ['v2', 600], ['v3', 600], ['v4', 600]]),
  });
  const m = s.averages;

  // Four days of range, not five: the count of calendar days adds one day for
  // the open bounds, which is right for "X active days out of Y" but would skew
  // the mean.
  check('moyennes : rapportées à la durée réelle, pas aux jours civils touchés',
    Math.round(m.perCoveredDay.videos * 100) === 100, [m.perCoveredDay.videos, s.rangeDays]);
  check('moyennes : par jour actif, seuls les jours regardés comptent',
    m.perActiveDay.videos === 2, [m.perActiveDay.videos, s.activeDays]);
  check('moyennes : le temps suit le même dénominateur',
    m.perActiveDay.seconds === 1200, m.perActiveDay.seconds);

  // Two channels on the first day, one on the second: the daily mean is 1.5
  // channels, not 3 — channels do not add up from one day to the next, they are
  // counted per day.
  check('moyennes : les chaînes distinctes se comptent par jour',
    m.perActiveDay.channels === 1.5, m.perActiveDay.channels);

  // A single week here: the week's two distinct channels do not make three, even
  // seen on two different days.
  check('moyennes : sur la semaine, une chaîne vue deux jours ne compte qu’une fois',
    m.perWeek.channels === 2, m.perWeek.channels);
}

/**
 * Cutting into sessions.
 *
 * The cut is on inactivity, not on the raw gap: following on with an hour and a
 * half podcast leaves a large gap without anything being interrupted, and a raw
 * threshold of thirty minutes cut the session in two.
 */
function testSessions(check) {
  const base = Date.parse('2026-04-01T20:00:00');
  const MIN = 60_000;
  const entries = [
    { videoId: 'long0000000', watchedAt: base, title: 'x', channelId: 'UCa', channelTitle: 'A' },
    // An hour and a half later: the previous video lasted exactly 1 h 30.
    { videoId: 'suite000000', watchedAt: base + 90 * MIN, title: 'x', channelId: 'UCa', channelTitle: 'A' },
  ];
  const durations = new Map([['long0000000', 5400], ['suite000000', 600]]);

  check('séances : la durée de la vidéo en cours ne coupe pas la séance',
    hist.computeStats(entries, { durations }).sessions.count === 1,
    hist.computeStats(entries, { durations }).sessions.count);

  // With no known duration, the video is credited with thirty minutes: the
  // effective threshold becomes one hour of raw gap.
  const proche = [entries[0], { ...entries[1], watchedAt: base + 55 * MIN }];
  check('séances : sans durée connue, une heure d’écart reste la même séance',
    hist.computeStats(proche).sessions.count === 1,
    hist.computeStats(proche).sessions.count);
  check('séances : au-delà, sans durée connue, la séance est coupée',
    hist.computeStats(entries).sessions.count === 2,
    hist.computeStats(entries).sessions.count);

  const loin = hist.computeStats([
    entries[0],
    { ...entries[1], watchedAt: base + 300 * MIN },
  ], { durations });
  check('séances : cinq heures plus tard, c’est une autre séance',
    loin.sessions.count === 2, loin.sessions.count);
  check('séances : la taille moyenne est rapportée au nombre de séances',
    loin.sessions.videosPerSession === 1, loin.sessions.videosPerSession);
}

/** The concentration exists for both of the ranking's quantities. */
function testConcentration(check) {
  const entries = [];
  // A short but much watched channel, a rare but long one: the two rankings
  // differ, hence so do the two concentrations.
  for (let i = 0; i < 10; i++) {
    entries.push({ videoId: `court${i}`, watchedAt: 1000 + i, title: 'x', channelId: 'UCa', channelTitle: 'A' });
  }
  entries.push({ videoId: 'longue00000', watchedAt: 2000, title: 'x', channelId: 'UCb', channelTitle: 'B' });

  const durations = new Map(entries.map((e) => [e.videoId, e.videoId === 'longue00000' ? 36000 : 60]));
  const s = hist.computeStats(entries, { durations });

  const vues = s.concentration.find((p) => p.n === 1).share;
  const temps = s.concentrationByTime.find((p) => p.n === 1).share;
  check('concentration : la première chaîne par vues n’est pas celle par temps',
    Math.round(vues * 100) === 91 && Math.round(temps * 100) === 98, [vues, temps]);
  check('concentration : les deux séries ont les mêmes paliers',
    s.concentration.length === s.concentrationByTime.length);
}

/** Cross checking against the current subscriptions. */
function testAbonnements(check) {
  const entries = [
    { videoId: 'v1', watchedAt: 1000, title: 'x', channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa', channelTitle: 'A' },
    { videoId: 'v2', watchedAt: 1001, title: 'x', channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa', channelTitle: 'A' },
    { videoId: 'v3', watchedAt: 1002, title: 'x', channelId: 'UCbbbbbbbbbbbbbbbbbbbbbb', channelTitle: 'B' },
    { videoId: 'v4', watchedAt: 1003, title: 'x', channelId: 'UCcccccccccccccccccccccc', channelTitle: 'C' },
  ];

  const s = hist.computeStats(entries, { subscribed: new Set(['UCaaaaaaaaaaaaaaaaaaaaaa']) });
  check('abonnements : les vues rattachées à un abonnement sont comptées',
    s.subscriptionViews === 2, s.subscriptionViews);
  check('abonnements : la part se rapporte à toutes les vues',
    s.subscriptionShare === 0.5, s.subscriptionShare);
  check('abonnements : chaque chaîne sait si elle est suivie',
    s.topChannels.find((c) => c.title === 'A').subscribed
      && !s.topChannels.find((c) => c.title === 'B').subscribed);

  const sans = hist.computeStats(entries);
  check('abonnements : sans liste d’abonnements, la part vaut zéro',
    sans.subscriptionViews === 0 && sans.subscriptionShare === 0);

  // Heavily watched channels with no subscription are looked for in the whole
  // ranking, not in the fifteen lines shown: with `topN` at 1, the candidate
  // stays findable.
  const large = [];
  for (let i = 0; i < 40; i++) {
    large.push({ videoId: `t${i}`, watchedAt: 1000 + i, title: 'x', channelId: 'UCsuivie', channelTitle: 'Suivie' });
  }
  for (let i = 0; i < 3; i++) {
    large.push({ videoId: `c${i}`, watchedAt: 2000 + i, title: 'x', channelId: 'UCautre', channelTitle: 'Autre' });
  }
  const c = hist.computeStats(large, { topN: 1, subscribed: new Set(['UCsuivie']) });
  check('abonnements : une candidate hors du top affiché est quand même trouvée',
    c.unsubscribedCandidates.length === 1
      && c.unsubscribedCandidates[0].channelId === 'UCautre', c.unsubscribedCandidates);
  check('abonnements : en dessous de trois vues, une chaîne n’est pas candidate',
    hist.computeStats(large.slice(0, 41), { topN: 1, subscribed: new Set(['UCsuivie']) })
      .unsubscribedCandidates.length === 0);
}

/**
 * Dense daily series.
 *
 * Days with no viewing are worth zero and not "nothing": a sparse series would
 * make the troughs disappear, and two days separated by three weeks of
 * inactivity would end up side by side on the curve.
 */
function testSerieQuotidienne(check) {
  const from = Date.parse('2026-03-01T00:00:00');
  const to = Date.parse('2026-03-05T23:59:59');
  const s = hist.computeStats([
    { videoId: 'v1', watchedAt: Date.parse('2026-03-01T10:00:00'), title: 'x', channelId: 'UCa', channelTitle: 'A' },
    { videoId: 'v2', watchedAt: Date.parse('2026-03-01T11:00:00'), title: 'x', channelId: 'UCa', channelTitle: 'A' },
    { videoId: 'v3', watchedAt: Date.parse('2026-03-04T11:00:00'), title: 'x', channelId: 'UCa', channelTitle: 'A' },
  ], { from, to });

  const serie = s.dailySeries;
  check('série : un point par jour de la plage, sans trou',
    serie.length === 5, serie.length);
  check('série : les jours vides valent zéro',
    JSON.stringify(serie.map(([, n]) => n)) === '[2,0,0,1,0]', serie);
  check('série : les jours sont des dates ISO ordonnées',
    serie[0][0] === '2026-03-01' && serie[4][0] === '2026-03-05', [serie[0][0], serie[4][0]]);
  check('série : une plage vide ne produit aucun point',
    hist.computeStats([], { from, to }).dailySeries.length === 0);
}

/** Topic dictionary: recognition by terms, not by statistics. */
function testSujets(check) {
  const r = hist.classifyTopics([
    { videoId: 'a', title: 'Tuto Python : machine learning de zéro' },
    { videoId: 'b', title: 'Le meilleur match de la NBA cette saison' },
    { videoId: 'c', title: 'Un titre sans aucun terme reconnu ici' },
    { videoId: 'd', title: 'Vous avez regardé', nonResolue: true },
  ]);
  const noms = r.topics.map((s) => s.name);

  // "python" and "tuto" on one side, the phrase "machine learning" on the
  // other: the same title legitimately belongs to both topics.
  check('sujets : un titre peut relever de deux sujets à la fois',
    noms.includes('Développement') && noms.includes('IA et machine learning'), noms);
  check('sujets : les termes de plusieurs mots sont reconnus',
    r.topics.find((s) => s.name === 'IA et machine learning').count === 1, r.topics);
  check('sujets : un mot simple isolé suffit', noms.includes('Sport'), noms);
  check('sujets : un titre non reconnu n’est classé nulle part',
    r.classified === 2 && r.total === 3, [r.classified, r.total]);
  check('sujets : les entrées non résolues ne comptent pas',
    r.total === 3, r.total);

  // "ia" must not fire on "médIA": single word terms are looked for as whole
  // words, otherwise the broadest category swallows the whole ranking.
  const piege = hist.classifyTopics([{ videoId: 'x', title: 'Les médias et la sociologie' }]);
  check('sujets : un mot court ne se déclenche pas à l’intérieur d’un autre',
    !piege.topics.some((s) => s.name === 'IA et machine learning'), piege.topics);
}

/**
 * A channel's report.
 *
 * Two horizons live in it: consumption is about the range, the relationship —
 * first seen, streak, coverage — is about the whole history. Confusing them
 * would give "followed for 30 days" to someone who has followed a channel for
 * two years.
 */
function testFicheChaine(check) {
  const J = (iso) => Date.parse(iso);
  const entries = [
    { videoId: 'v1', watchedAt: J('2024-01-10T10:00:00'), title: 'Ancienne', channelId: 'UCa', channelTitle: 'A' },
    { videoId: 'v2', watchedAt: J('2026-08-01T10:00:00'), title: 'Rocket League run', channelId: 'UCa', channelTitle: 'A' },
    { videoId: 'v2', watchedAt: J('2026-08-02T10:00:00'), title: 'Rocket League run', channelId: 'UCa', channelTitle: 'A' },
    { videoId: 'v3', watchedAt: J('2026-08-03T10:00:00'), title: 'Rocket League fin', channelId: 'UCa', channelTitle: 'A' },
    { videoId: 'x1', watchedAt: J('2026-08-03T11:00:00'), title: 'Ailleurs', channelId: 'UCb', channelTitle: 'B' },
  ];

  const f = hist.computeChannelReport(entries, {
    channelId: 'UCa',
    from: J('2026-08-01T00:00:00'), to: J('2026-08-31T23:59:59'),
    durations: new Map([['v2', 600], ['v3', 1200]]),
    // v3 and v2 are the channel's last two videos, v4 has never been watched.
    uploads: ['v3', 'v2', 'v4', 'v1'],
  });

  check('fiche : les ouvertures de la plage sont comptées', f.opens === 3, f.opens);
  check('fiche : une vidéo rouverte ne fait qu’une ligne',
    f.distinctVideos === 2 && f.videos.length === 2, [f.distinctVideos, f.videos.length]);
  check('fiche : et ne compte son temps qu’une fois', f.seconds === 1800, f.seconds);
  check('fiche : la plus récemment vue est en tête', f.videos[0].videoId === 'v3', f.videos[0]);
  check('fiche : le nombre d’ouvertures reste visible par vidéo',
    f.videos.find((v) => v.videoId === 'v2').opens === 2);

  // The relationship ignores the range: the first view dates from 2024, outside it.
  check('fiche : la première vue porte sur tout l’historique',
    new Date(f.firstSeen).getFullYear() === 2024, new Date(f.firstSeen).toISOString());
  check('fiche : le total d’ouvertures aussi', f.totalOpens === 4, f.totalOpens);

  // Three of the four known videos have been watched at some point, and the two
  // most recent ones in a row.
  check('fiche : la couverture se calcule sur les vidéos connues',
    f.coverage === 0.75, f.coverage);
  check('fiche : la série s’arrête à la première non vue', f.streak === 2, f.streak);
  check('fiche : une série inférieure au connu n’est pas plafonnée',
    f.streakCapped === false);

  // The best streak is looked for everywhere in the list, not only at the top:
  // missing the last video resets the streak under way without erasing what was
  // followed before.
  const manquee = hist.computeChannelReport(entries, {
    channelId: 'UCa',
    uploads: ['v4', 'v3', 'v2', 'v1'],
  });
  check('fiche : la dernière vidéo non vue annule la série en cours',
    manquee.streak === 0, manquee.streak);
  check('fiche : la meilleure série survit à la vidéo manquée',
    manquee.streakMax === 3, manquee.streakMax);
  check('fiche : sans interruption, meilleure série et série en cours coïncident',
    f.streakMax === 2, f.streakMax);

  check('fiche : une chaîne absente de l’historique ne renvoie rien',
    hist.computeChannelReport(entries, { channelId: 'UCzzz' }) === null);

  // With no videos recovered, neither the coverage nor the streak can be
  // measured: returning zero would suggest no following at all.
  const sansUploads = hist.computeChannelReport(entries, { channelId: 'UCa' });
  check('fiche : sans vidéos connues, la couverture est inconnue et non nulle',
    sansUploads.coverage === null, sansUploads.coverage);

  // Share of the video actually watched on this channel. Unlike content time,
  // it counts every opening: reopening v2 and seeing only half of it each time
  // really is half of v2 watched on average.
  check('fiche : sans mesure, la part vue est inconnue et non nulle',
    f.watchedShare === null, f.watchedShare);

  const mesuree = hist.computeChannelReport(
    entries.map((e) => (e.videoId === 'v2' ? { ...e, watchedSec: 300 } : e)), {
      channelId: 'UCa',
      from: J('2026-08-01T00:00:00'), to: J('2026-08-31T23:59:59'),
      durations: new Map([['v2', 600], ['v3', 1200]]),
    });
  check('fiche : la part vue rapporte le temps mesuré à la durée ouverte',
    mesuree.watchedShare === 0.5, mesuree.watchedShare);
  check('fiche : les ouvertures mesurées sont dénombrées à part',
    mesuree.measuredOpens === 2, mesuree.measuredOpens);
  check('fiche : le temps réellement regardé ne sature pas comme le contenu',
    mesuree.watchedSeconds === 600, mesuree.watchedSeconds);

  // The measured time comes down to each video's line: that is where it is read
  // against the duration, and hence the only place where one sees that a twenty
  // minute video was abandoned after three.
  const v2 = mesuree.videos.find((v) => v.videoId === 'v2');
  const v3 = mesuree.videos.find((v) => v.videoId === 'v3');
  check('fiche : chaque vidéo porte le temps passé dessus',
    v2.watchedSeconds === 600 && v2.measured === 2, [v2?.watchedSeconds, v2?.measured]);
  check('fiche : une vidéo jamais mesurée n’affiche pas zéro',
    v3.watchedSeconds === null && v3.measured === 0, [v3?.watchedSeconds, v3?.measured]);
}

/**
 * The videos behind a theme or a topic.
 *
 * The figure shown next to the theme and the list opened on click have to
 * coincide: a broader match — on substrings rather than on words — would bring
 * back videos the count never counted.
 */
function testVideosParTerme(check) {
  const J = (iso) => Date.parse(iso);
  const entries = [
    { videoId: 'v1', watchedAt: J('2026-05-01T10:00:00'), title: 'Rocket League highlights', channelId: 'UCa', channelTitle: 'A' },
    { videoId: 'v1', watchedAt: J('2026-05-02T10:00:00'), title: 'Rocket League highlights', channelId: 'UCa', channelTitle: 'A' },
    { videoId: 'v2', watchedAt: J('2026-05-03T10:00:00'), title: 'Le meilleur de Rocket League', channelId: 'UCb', channelTitle: 'B' },
    { videoId: 'v3', watchedAt: J('2026-05-04T10:00:00'), title: 'Tuto python débutant', channelId: 'UCa', channelTitle: 'A' },
    { videoId: 'v4', watchedAt: J('2026-05-05T10:00:00'), title: 'Diagonale et biais', channelId: 'UCa', channelTitle: 'A' },
    { videoId: 'v5', watchedAt: J('2020-01-01T10:00:00'), title: 'Rocket League ancien', channelId: 'UCa', channelTitle: 'A' },
  ];

  const rl = hist.findVideosByTerm(entries, { term: 'rocket league' });
  check('termes : une vidéo par ligne, quelles que soient les ouvertures',
    rl.length === 3, rl.map((v) => v.videoId));
  check('termes : les ouvertures restent comptées',
    rl.find((v) => v.videoId === 'v1').opens === 2);
  check('termes : la plus récente d’abord', rl[0].videoId === 'v2', rl[0].videoId);
  check('termes : la chaîne voyage avec la vidéo',
    rl[0].channelTitle === 'B', rl[0].channelTitle);

  const borne = hist.findVideosByTerm(entries, {
    term: 'rocket league', from: J('2026-01-01T00:00:00'), to: J('2026-12-31T23:59:59'),
  });
  check('termes : la plage est respectée', borne.length === 2, borne.length);

  const uneChaine = hist.findVideosByTerm(entries, { term: 'rocket league', channelId: 'UCa' });
  check('termes : on peut se restreindre à une chaîne',
    uneChaine.length === 2, uneChaine.map((v) => v.videoId));

  // "ia" must not fire inside "diagonale" nor inside "biais".
  const sujet = hist.findVideosByTerm(entries, { topic: 'IA et machine learning' });
  check('termes : un sujet ne se déclenche pas à l’intérieur d’un mot',
    sujet.length === 0, sujet.map((v) => v.title));

  const dev = hist.findVideosByTerm(entries, { topic: 'Développement' });
  check('termes : un sujet couvre tous les termes de sa catégorie',
    dev.length === 1 && dev[0].videoId === 'v3', dev.map((v) => v.videoId));

  check('termes : sans terme ni sujet, rien plutôt que tout',
    hist.findVideosByTerm(entries, {}).length === 0);
}

/** Directory for the search. */
function testAnnuaire(check) {
  const entries = [
    { videoId: 'a', watchedAt: 1000, title: 'x', channelId: 'UCa', channelTitle: 'Arte' },
    { videoId: 'a', watchedAt: 2000, title: 'x', channelId: 'UCa', channelTitle: 'Arte' },
    { videoId: 'b', watchedAt: 3000, title: 'x', channelId: 'UCb', channelTitle: 'Blast' },
    { videoId: 'c', watchedAt: 4000, title: 'x', nonResolue: true },
  ];
  const liste = hist.listHistoryChannels(entries, { durations: new Map([['a', 600], ['b', 300]]) });

  check('annuaire : une ligne par chaîne, la plus vue d’abord',
    liste.length === 2 && liste[0].title === 'Arte', liste.map((c) => c.title));
  check('annuaire : les ouvertures sont comptées intégralement',
    liste[0].opens === 2, liste[0].opens);
  check('annuaire : les vidéos distinctes le sont aussi',
    liste[0].count === 1, liste[0].count);
  check('annuaire : le temps applique la même saturation qu’ailleurs',
    liste[0].seconds === 600, liste[0].seconds);
  check('annuaire : la dernière vue est retenue', liste[0].lastSeen === 2000);
  check('annuaire : la première aussi, pour la question de la découverte',
    liste[0].firstSeen === 1000, liste[0].firstSeen);
  check('annuaire : les entrées sans chaîne sont écartées',
    !liste.some((c) => c.title === 'Chaîne inconnue'));

  // The duel asks about the month and the year in progress. The windows are
  // calendar ones, not sliding: “this month” means since the first of the
  // month, which is what one has in mind when answering.
  const now = new Date(2026, 7, 20).getTime();
  const dated = [
    { videoId: 'm', watchedAt: new Date(2026, 7, 10).getTime(), channelId: 'UCa', channelTitle: 'Arte' },
    { videoId: 'm', watchedAt: new Date(2026, 7, 12).getTime(), channelId: 'UCa', channelTitle: 'Arte' },
    { videoId: 'y', watchedAt: new Date(2026, 2, 3).getTime(), channelId: 'UCa', channelTitle: 'Arte' },
    { videoId: 'o', watchedAt: new Date(2024, 5, 1).getTime(), channelId: 'UCa', channelTitle: 'Arte' },
  ];
  const fenetres = hist.listHistoryChannels(dated, {
    now, durations: new Map([['m', 600], ['y', 300], ['o', 1200]]),
  })[0];

  check('annuaire : le mois en cours ne compte que ses vidéos',
    fenetres.month.count === 1 && fenetres.month.seconds === 600,
    [fenetres.month.count, fenetres.month.seconds]);
  check('annuaire : l’année en cours englobe le mois',
    fenetres.year.count === 2 && fenetres.year.seconds === 900,
    [fenetres.year.count, fenetres.year.seconds]);
  check('annuaire : un revisionnage ne gonfle pas la fenêtre',
    fenetres.opens === 4 && fenetres.count === 3,
    [fenetres.opens, fenetres.count]);
}

/**
 * Detecting tabs left open.
 *
 * Cases built from real measurements: on an export of 15,400 entries, a tab
 * reopened every morning gave 94 views at a 1.13 day median gap, where a course
 * genuinely studied again 39 times showed a 3.8 day gap. It is the regularity,
 * not the number of views, that separates the two.
 */
function testAutoOpened(check) {
  const JOUR = 86_400_000;
  const base = Date.parse('2026-01-01T09:00:00Z');
  const entries = [];

  // One tab: one view a day, every day.
  for (let i = 0; i < 30; i++) {
    entries.push({ videoId: 'onglet00000', watchedAt: base + i * JOUR, title: 'Onglet', channelTitle: 'A' });
  }
  // A real rewatch: irregular, sometimes twice on the same day.
  for (const j of [0, 4, 4.2, 11, 25, 60, 61, 90]) {
    entries.push({ videoId: 'etude000000', watchedAt: base + j * JOUR, title: 'Cours', channelTitle: 'B' });
  }
  entries.push({ videoId: 'unique00000', watchedAt: base, title: 'Vue une fois', channelTitle: 'C' });

  const suspects = hist.detectAutoOpened(entries, { minViews: 6 });
  const onglet = suspects.find((s) => s.videoId === 'onglet00000');
  const etude = suspects.find((s) => s.videoId === 'etude000000');

  check('onglets : une vidéo vue une fois n’est jamais suspecte',
    !suspects.some((s) => s.videoId === 'unique00000'));
  check('onglets : le seuil de vues retient les deux candidats',
    Boolean(onglet && etude), suspects.map((s) => s.videoId));
  check('onglets : l’onglet est marqué régulier et sans doublon de jour',
    onglet.oneADay && onglet.regular && onglet.medianGapDays === 1,
    [onglet.oneADay, onglet.regular, onglet.medianGapDays]);
  check('onglets : le revisionnage réel n’est pas marqué régulier',
    !etude.regular && !etude.oneADay, [etude.regular, etude.oneADay, etude.medianGapDays]);
  check('onglets : les plus vues d’abord', suspects[0].videoId === 'onglet00000');

  // Default threshold: watching a video ten times stays plausible when studying
  // it over a week, so only the eleventh opening raises the suspicion. A stricter
  // threshold ruled out real viewings.
  const dix = Array.from({ length: 10 }, (_, i) => (
    { videoId: 'dixfois0000', watchedAt: base + i * JOUR, title: 'Dix', channelTitle: 'D' }));
  check('onglets : dix ouvertures ne suffisent pas par défaut',
    hist.detectAutoOpened(dix).length === 0, hist.detectAutoOpened(dix));
  dix.push({ videoId: 'dixfois0000', watchedAt: base + 10 * JOUR, title: 'Dix', channelTitle: 'D' });
  check('onglets : la onzième déclenche le soupçon',
    hist.detectAutoOpened(dix).length === 1, hist.detectAutoOpened(dix));
}

/** Streaks per channel: the last N videos watched without a break. */
function testStreaks(check) {
  const vues = ['v1', 'v2', 'v3', 'v6'].map((videoId) => ({ videoId }));
  const uploads = new Map([
    ['UCaaaaaaaaaaaaaaaaaaaaaa', ['v1', 'v2', 'v3', 'v4', 'v5']],
    ['UCbbbbbbbbbbbbbbbbbbbbbb', ['v6', 'v7']],
    ['UCcccccccccccccccccccccc', ['v8', 'v9']],
  ]);

  const series = hist.computeChannelStreaks(vues, uploads);
  check('séries : la série s’arrête à la première vidéo non vue',
    series[0].streak === 3, series[0]);
  check('séries : une chaîne sans aucune vidéo vue est absente',
    !series.some((s) => s.channelId === 'UCcccccccccccccccccccccc'));
  check('séries : une série partielle n’est pas plafonnée',
    series[0].capped === false, series[0].capped);

  // Everything known has been watched: the streak is a floor, not a total.
  // Without this signal, the interface would show a maximum that is not one.
  const tout = hist.computeChannelStreaks(
    [{ videoId: 'v1' }, { videoId: 'v2' }],
    new Map([['UCaaaaaaaaaaaaaaaaaaaaaa', ['v1', 'v2']]]));
  check('séries : une série égale au connu est signalée comme plafonnée',
    tout[0].capped === true && tout[0].known === 2, tout[0]);

  // A video released this morning is not a missed video: the streak waits for
  // it. Without this, a channel followed for years dropped to zero on the day of
  // an upload, which is exactly the opposite of what the figure tells.
  const frais = hist.computeChannelStreaks(
    [{ videoId: 'v2' }, { videoId: 'v3' }],
    new Map([['UCaaaaaaaaaaaaaaaaaaaaaa', ['v1', 'v2', 'v3']]]),
    { recent: new Set(['v1']) });
  check('séries : un upload tout frais non vu ne casse pas la série',
    frais[0]?.streak === 2 && frais[0]?.pending === 1, frais[0]);

  const vieux = hist.computeChannelStreaks(
    [{ videoId: 'v2' }, { videoId: 'v3' }],
    new Map([['UCaaaaaaaaaaaaaaaaaaaaaa', ['v1', 'v2', 'v3']]]));
  check('séries : un upload ancien non vu casse bien la série', !vieux.length, vieux);
}

/** Themes: the phrases absorb the words that make them up. */
function testThemes(check) {
  const entries = [];
  for (let i = 0; i < 6; i++) {
    entries.push({ videoId: `a${i}`, title: `Rocket League highlights ${i}`, nonResolue: false });
  }
  entries.push({ videoId: 'z', title: 'Vous avez regardé', nonResolue: true });

  const themes = hist.extractThemes(entries, { minCount: 4 });
  const textes = themes.map((t) => t.text);

  check('thèmes : une expression de deux mots ressort',
    textes.includes('rocket league'), textes);
  check('thèmes : ses mots ne sont pas répétés séparément',
    !textes.includes('rocket') && !textes.includes('league'), textes);
  check('thèmes : les entrées non résolues sont ignorées',
    !textes.some((t) => t.includes('regardé')), textes);
  check('thèmes : les mots vides sont écartés',
    !textes.includes('avez') && !textes.includes('vous'), textes);

  // The threshold follows the volume: frozen at four, a seven day range gave
  // back almost nothing. Two occurrences are enough on a small sample.
  const petit = [
    { videoId: 'p1', title: 'Comment utiliser un tableur' },
    { videoId: 'p2', title: 'Comment utiliser un tableur pro' },
  ];
  check('thèmes : le seuil s’abaisse sur un petit échantillon',
    hist.extractThemes(petit).some((x) => x.text === 'tableur'),
    hist.extractThemes(petit));

  // "use" came out at the top of the topics when it is not one.
  const anglais = Array.from({ length: 4 }, (_, i) => (
    { videoId: `e${i}`, title: `How to use the thing ${i}` }));
  check('thèmes : « use » est un mot vide',
    !hist.extractThemes(anglais).some((x) => x.text.includes('use')),
    hist.extractThemes(anglais));

  // The invariant that was missing: a theme is clicked. The phrases were formed
  // from the words left after filtering, hence from words that do not follow one
  // another in the title, and the search found nothing back.
  const pieges = [];
  for (let i = 0; i < 8; i++) {
    pieges.push({ videoId: `t${i}`, watchedAt: 10, title: `Comment utiliser le clavier d’Apple ${i}` });
    pieges.push({ videoId: `u${i}`, watchedAt: 10, title: `Rocket, mais dans League of Legends ${i}` });
  }
  const orphelins = hist.extractThemes(pieges)
    .filter((x) => !hist.findVideosByTerm(pieges, { term: x.text }).length)
    .map((x) => x.text);
  check('thèmes : chaque thème retrouve au moins une vidéo', !orphelins.length, orphelins);

  // The figure shown is the one of the list that opens. Counted in openings, it
  // exceeded the number of videos as soon as one was watched again.
  const revus = [
    { videoId: 'r1', watchedAt: 10, title: 'Le grand tutoriel du clavier' },
    { videoId: 'r1', watchedAt: 20, title: 'Le grand tutoriel du clavier' },
    { videoId: 'r2', watchedAt: 30, title: 'Le grand tutoriel du clavier' },
  ];
  const ecarts = hist.extractThemes(revus, { minCount: 2 })
    .filter((x) => x.n !== hist.findVideosByTerm(revus, { term: x.text }).length)
    .map((x) => [x.text, x.n, hist.findVideosByTerm(revus, { term: x.text }).length]);
  check('thèmes : le compte est en vidéos, pas en ouvertures', !ecarts.length, ecarts);
}

/** Order of appearance and wordings of the subscriptions triage. */
/**
 * Figure hooks.
 *
 * What is checked here is the threshold, not the computation: an accurate but
 * derisory hook ("your longest streak: 2 days") serves the tab worse than empty
 * space, and it is the kind of regression one only sees once the extension is
 * installed on a fresh account.
 */
function testAccroches(check) {
  const now = Date.parse('2026-08-19T12:00:00Z');
  const cles = (liste) => liste.map((a) => a.key);

  // -- triage side
  const chaine = (over) => ({
    id: 'UC' + 'x'.repeat(22), title: 'Chaîne', addedAt: now - 400 * DAY,
    lastUploadAt: now - DAY, uploadIntervalMs: 15 * DAY,
    videoCount: 10, hiddenCount: 0, watchedCount: 3, ...over,
  });

  const muette = chaine({ lastUploadAt: now - 900 * DAY });
  const jamais = chaine({ watchedCount: 0 });
  const masquee = chaine({ hiddenCount: 8 });
  const regardee = chaine({ watchedCount: 40 });

  const triChiffres = tri.triageFigures([muette, jamais, masquee, regardee], { now });
  check('chiffres tri : une seule chaîne muette', triChiffres.silent === 1, triChiffres);
  check('chiffres tri : le masquage se compte au dessus de 70 %',
    triChiffres.mostlyHidden === 1, triChiffres);
  check('chiffres tri : une jamais regardée', triChiffres.neverWatched === 1, triChiffres);
  // Four channels at one video a fortnight: a little under two a week between
  // them.
  check('chiffres tri : le débit hebdomadaire se cumule',
    triChiffres.perWeek === 2, triChiffres.perWeek);

  // On a fresh install, nobody has watched anything yet: saying that every
  // channel is neglected would be false and discouraging.
  const neuve = tri.triageFigures([chaine({ watchedCount: 0 }), chaine({ watchedCount: 0 })], { now });
  check('chiffres tri : « jamais regardée » se tait sans suivi de lecture',
    neuve.neverWatched === null, neuve);

  // -- history side
  const vue = (jour, heure, over = {}) => ({
    videoId: `v${jour}-${heure}-${over.suffixe ?? ''}`,
    channelId: 'UC' + 'a'.repeat(22),
    channelTitle: 'ScienceEtonnante',
    watchedAt: Date.parse(`2026-0${jour < 10 ? '1' : '1'}-${String(jour).padStart(2, '0')}T${String(heure).padStart(2, '0')}:30:00`),
    ...over,
  });

  const vide = hist.historyHighlights([], { now });
  check('accroches historique : rien à dire sur un historique vide',
    vide.length === 0, cles(vide));

  // Six videos on the same day, at the same hour: the day's record passes the
  // threshold, the favourite hour does not — twenty openings are required.
  const record = Array.from({ length: 6 }, (_, i) => vue(14, 21, { suffixe: i }));
  const acc = hist.historyHighlights(record, { now });
  check('accroches historique : le jour record est retenu à partir de cinq vidéos',
    cles(acc).includes('acc.hist.jour'), cles(acc));
  check('accroches historique : l’heure de prédilection attend vingt ouvertures',
    !cles(acc).includes('acc.hist.heure'), cles(acc));
  check('accroches historique : le jour record porte sa date',
    acc.find((a) => a.key === 'acc.hist.jour').at > 0);

  // A three day streak does not deserve announcing, four does.
  const serie = (n) => Array.from({ length: n }, (_, i) => vue(1 + i, 20, { suffixe: 's' }))
    .map((e, i) => ({ ...e, videoId: `serie-${i}` }));
  check('accroches historique : une série de trois jours reste muette',
    !cles(hist.historyHighlights(serie(3), { now })).includes('acc.hist.serie'));
  check('accroches historique : une série de quatre jours est annoncée',
    hist.historyHighlights(serie(4), { now })
      .find((a) => a.key === 'acc.hist.serie')?.n === 4);

  // The exclusions hold here as everywhere: a Short set aside must neither
  // inflate a record nor count as a crossed channel.
  const avecShort = [...record, vue(14, 21, { videoId: 'short1', suffixe: 'sh' })];
  const sansShort = hist.historyHighlights(avecShort, {
    now, excludedVideos: new Set(['short1']),
  });
  check('accroches historique : les vidéos exclues ne comptent pas',
    sansShort.find((a) => a.key === 'acc.hist.jour').n === 6,
    sansShort.find((a) => a.key === 'acc.hist.jour').n);

  // Time is counted per distinct video: reopening a tab does not add an hour of
  // viewing, but it does count as a reopening.
  const rouvertes = [];
  const durations = new Map();
  for (let i = 0; i < 5; i++) {
    const e = { ...vue(5, 20), videoId: `rouverte-${i}` };
    rouvertes.push(e, { ...e });
    durations.set(e.videoId, 40_000);
  }
  const tempsAcc = hist.historyHighlights(rouvertes, { now, durations });
  // Five 40,000 s videos opened twice: two days of content, and not four. The
  // history does not tell a rewatch from a reopened tab.
  check('accroches historique : le temps ne compte chaque vidéo qu’une fois',
    tempsAcc.find((a) => a.key === 'acc.hist.temps')?.n === 2,
    tempsAcc.find((a) => a.key === 'acc.hist.temps')?.n);
  check('accroches historique : les réouvertures se comptent, elles',
    tempsAcc.find((a) => a.key === 'acc.hist.revues')?.n === 5,
    tempsAcc.find((a) => a.key === 'acc.hist.revues')?.n);

  // Each hook's sentence has to exist in both catalogues, otherwise the popup
  // shows a raw key in place of the tab's most visible figure.
  const toutes = [...acc, ...tempsAcc].map((a) => a.key);
  check('accroches : toutes les clés sont traduites',
    toutes.every((c) => c in fr && c in en), toutes.filter((c) => !(c in fr && c in en)));
}

function testTriageOrder(check) {
  const now = Date.parse('2026-08-10T12:00:00Z');
  const MONTH = 30 * DAY;
  const mk = (over) => ({
    id: 'UC' + 'x'.repeat(22), title: 'Chaîne', addedAt: now - 400 * DAY,
    lastUploadAt: now - DAY, uploadIntervalMs: 15 * DAY,
    videoCount: 10, hiddenCount: 0, watchedCount: 3, ...over,
  });

  const active = mk({ title: 'Active' });
  const morte = mk({ title: 'Morte', lastUploadAt: now - 30 * MONTH, watchedCount: 0 });
  const ignoree = mk({ title: 'Ignorée', hiddenCount: 9, watchedCount: 0 });

  check('score : une chaîne active est peu suspecte',
    tri.suspicionScore(active, now) < 0.2, tri.suspicionScore(active, now).toFixed(2));
  // Total inactivity saturates its term, which weighs 0.45 of the score. That is
  // the maximum reachable by that signal alone — the remaining 0.10 comes from
  // the "never watched" term, inactive as long as the playback tracking has
  // nothing.
  check('score : l’inactivité pèse pour 0,45 à saturation',
    Math.abs(tri.suspicionScore(morte, now) - 0.45) < 0.01,
    tri.suspicionScore(morte, now).toFixed(2));
  check('score : une chaîne morte est bien plus suspecte qu’une active',
    tri.suspicionScore(morte, now) > tri.suspicionScore(active, now) + 0.4);
  check('score : le masquage systématique pèse autant',
    tri.suspicionScore(ignoree, now) > 0.4, tri.suspicionScore(ignoree, now).toFixed(2));

  // The point that would turn everything upside down: watching a video must
  // never count as having set it aside. Two identical channels, one much
  // watched, the other systematically hidden.
  const regardee = mk({ title: 'Très regardée', watchedCount: 10, hiddenCount: 0 });
  const rejetee = mk({ title: 'Systématiquement masquée', watchedCount: 0, hiddenCount: 10 });
  check('score : une chaîne très regardée n’est pas jugée suspecte',
    tri.suspicionScore(regardee, now) < tri.suspicionScore(rejetee, now) - 0.3,
    { regardee: tri.suspicionScore(regardee, now).toFixed(2), rejetee: tri.suspicionScore(rejetee, now).toFixed(2) });

  // "Never watched anything" must only weigh if the tracking has data.
  const jamaisVue = mk({ watchedCount: 0, hiddenCount: 0 });
  check('score : sans historique de lecture, le terme « jamais regardé » est neutre',
    tri.suspicionScore(jamaisVue, now, { hasWatchData: false })
    < tri.suspicionScore(jamaisVue, now, { hasWatchData: true }),
    { sans: tri.suspicionScore(jamaisVue, now, { hasWatchData: false }).toFixed(2),
      avec: tri.suspicionScore(jamaisVue, now, { hasWatchData: true }).toFixed(2) });
  check('tri : le suivi de lecture est détecté sur l’ensemble, pas par chaîne',
    tri.sortChannels([regardee, jamaisVue], tri.ORDERS.SUSPECT, now)[0].title === 'Chaîne',
    tri.sortChannels([regardee, jamaisVue], tri.ORDERS.SUSPECT, now).map((c) => c.title));

  const ordre = tri.sortChannels([active, morte, ignoree], tri.ORDERS.SUSPECT, now);
  check('ordre suspect : l’active passe en dernier',
    ordre[2].title === 'Active', ordre.map((c) => c.title));

  const alpha = tri.sortChannels(
    [mk({ title: 'Zèbre' }), mk({ title: 'École' }), mk({ title: 'ecole bis' }), mk({ title: 'Abeille' })],
    tri.ORDERS.ALPHA, now);
  check('ordre alphabétique : accents et casse ignorés',
    alpha.map((c) => c.title).join(',') === 'Abeille,École,ecole bis,Zèbre', alpha.map((c) => c.title));

  // The subscription date being reachable nowhere without OAuth, no order claims
  // to know it: two honest modes beat a third that shows an arbitrary ranking as
  // though it were chronological.
  check('deux ordres seulement, aucun ne prétend connaître la date d’abonnement',
    Object.keys(tri.ORDERS).length === 2 && !('OLDEST' in tri.ORDERS), Object.keys(tri.ORDERS));

  check('tri : le tableau d’origine n’est pas modifié', (() => {
    const src = [mk({ title: 'B' }), mk({ title: 'A' })];
    tri.sortChannels(src, tri.ORDERS.ALPHA, now);
    return src[0].title === 'B';
  })());

  // -- formulations
  check('cadence : chaîne active, au présent',
    /^Publie ≈ 2 vidéos par mois/.test(tri.describeCadence(active, now)),
    tri.describeCadence(active, now));
  check('cadence : chaîne éteinte, à l’imparfait',
    /quand elle était active$/.test(tri.describeCadence(morte, now)),
    tri.describeCadence(morte, now));
  check('cadence : inconnue si le rythme n’a pas été mesuré',
    tri.describeCadence(mk({ uploadIntervalMs: null }), now) === null);

  check('masquage : tu, affiché quand c’est significatif',
    /9 de ses 10/.test(tri.describeHiding(ignoree)), tri.describeHiding(ignoree));
  check('masquage : masqué si trop peu de vidéos masquées',
    tri.describeHiding(mk({ hiddenCount: 2 })) === null);
  check('masquage : masqué si trop peu de vidéos connues',
    tri.describeHiding(mk({ videoCount: 2, hiddenCount: 2 })) === null);

  // The viewing line only exists if the reading has something to say: on a fresh
  // install, "0 out of 12" would describe the extension, not the channel.
  const suivie = mk({ videoCount: 12, watchedCount: 4 });
  check('visionnage : affiché quand le relevé est alimenté',
    /4 sur les 12/.test(tri.describeWatching(suivie, { hasWatchData: true })),
    tri.describeWatching(suivie, { hasWatchData: true }));
  check('visionnage : muet tant que rien n’a été relevé nulle part',
    tri.describeWatching(suivie, { hasWatchData: false }) === null);
  check('visionnage : muet si trop peu de vidéos connues',
    tri.describeWatching(mk({ videoCount: 2, watchedCount: 1 }), { hasWatchData: true }) === null);
  check('visionnage : zéro vu est une information, pas une absence',
    /0 sur les 12/.test(tri.describeWatching(mk({ videoCount: 12, watchedCount: 0 }),
      { hasWatchData: true })));
  check('relevé alimenté : déduit de l’ensemble, pas d’une chaîne',
    tri.hasWatchData([mk({ watchedCount: 0 }), suivie]) === true
    && tri.hasWatchData([mk({ watchedCount: 0 })]) === false);

  const dormantes = tri.findDormant([active, morte, ignoree], 24, now);
  check('chaînes muettes : seule la morte est retenue',
    dormantes.length === 1 && dormantes[0].title === 'Morte', dormantes.map((c) => c.title));
}

/**
 * The completeness guard.
 *
 * Two possible regressions, and symmetrical ones: letting through a video we do
 * not know how to show in full, or withholding forever a video that has no
 * duration to have. A live under way is exactly that second case — it will only
 * have its duration once over, and withholding it until then would amount to
 * never showing a live, which is the one kind of content that loses all interest
 * if missed.
 */
async function testStrictComplete(check) {
  // A channel whose picture is unknown, next to those the fixtures know. Since
  // `reconcileChannels` deactivates the absent ones, the others have to be passed
  // to it again.
  await db.reconcileChannels([
    mkChannel(1), mkChannel(2), mkChannel(3),
    { id: channelId(9), title: 'Chaîne sans avatar' },
  ]);

  const t0 = BASE_TS + 400 * DAY;
  await db.upsertVideos([
    { id: 'strict0001', channelId: channelId(1), title: 'Complète',
      publishedAt: t0, thumbUrl: 'https://e/1', durationSec: 600 },
    { id: 'strict0002', channelId: channelId(1), title: 'Sans durée',
      publishedAt: t0 - 1000, thumbUrl: 'https://e/2' },
    { id: 'strict0003', channelId: channelId(9), title: 'Chaîne sans image',
      publishedAt: t0 - 2000, thumbUrl: 'https://e/3', durationSec: 600 },
    { id: 'strict0004', channelId: channelId(1), title: 'Direct en cours',
      publishedAt: t0 - 3000, thumbUrl: 'https://e/4', isLive: 1 },
    { id: 'strict0005', channelId: channelId(1), title: 'Déclarée introuvable',
      publishedAt: t0 - 4000, thumbUrl: 'https://e/5', durationSec: -1 },
  ]);

  const ouvert = await db.getFeedPage({ limit: 300 });
  const strict = await db.getFeedPage({ limit: 300, requireComplete: true });
  const avec = new Set(ouvert.items.map((v) => v.id));
  const sans = new Set(strict.items.map((v) => v.id));

  check('garde-fou : sans lui, les cinq passent',
    ['strict0001', 'strict0002', 'strict0003', 'strict0004', 'strict0005']
      .every((id) => avec.has(id)), [...avec].filter((id) => id.startsWith('strict')));

  // The Shorts catch-up: the database can only narrow the list of candidates, it
  // concludes nothing. Three minutes is a Short's ceiling, and anything whose
  // duration is unknown is a candidate too — the Atom feed carries no duration,
  // so requiring one made the backstop blind to exactly the population it exists
  // for. A Short did get through that way, in August 2026.
  const courtes = await db.listShortCandidates(null, 500, 100000);
  const idsCourtes = new Set(courtes.ids);
  check('Shorts : la vidéo de dix minutes n\u2019est pas candidate', !idsCourtes.has('strict0001'));
  check('Shorts : une durée inconnue est candidate', idsCourtes.has('strict0002'));
  check('Shorts : une durée déclarée introuvable aussi', idsCourtes.has('strict0005'));
  check('Shorts : le parcours se termine quand la base est épuisée', courtes.done === true);

  // The lap goes through the whole database and takes days to come back round.
  // YouTube reclassifies a video as a Short several hours after it goes up, so
  // the window that matters is the one that follows publication, and it has to
  // be looked at first — in publication order, newest first.
  //
  // What makes a video due is the date of its last verdict, never its duration:
  // a known duration says nothing about whether the video is a Short, and taking
  // it as a settled verdict is exactly what let one through in August 2026.
  const récentes = await db.listShortRecheck(t0, 10);
  check('Shorts : le passage récent prend les vidéos de la fenêtre, les brèves d’abord',
    récentes.join() === 'strict0002,strict0004,strict0005,strict0001,strict0003', récentes);
  check('Shorts : le passage récent respecte son plafond',
    (await db.listShortRecheck(t0, 2)).length === 2);

  // The cap is the whole reason the two lanes are gathered apart. Served from a
  // single list, newest first, two long uploads at the top of the window would
  // fill the slice and leave the brief ones — the only ones YouTube can still
  // reclassify — for a later pass.
  check('Shorts : sous plafond, ce sont les brèves qui passent, pas les plus récentes',
    (await db.listShortRecheck(t0, 2)).join() === 'strict0002,strict0004');

  check('Shorts : un verdict daté sort la vidéo du passage',
    (await db.markShortChecked(
      ['strict0001', 'strict0002', 'strict0003', 'strict0004', 'strict0005'], t0)) === 5
    && (await db.listShortRecheck(t0, 10)).length === 0);

  // Two periods, and duration decides which one applies — never what the video
  // is. A video of ten minutes is not one YouTube will turn into a Short, so it
  // waits three hours; anything at or under the ceiling, and anything whose
  // duration is unknown, is asked again at the quarter hour.
  check('Shorts : au quart d’heure, seules les brèves et les durées inconnues reviennent',
    (await db.listShortRecheck(t0 + db.SHORT_RECHECK_FAST_MS + 1, 10)).join()
      === 'strict0002,strict0004,strict0005');

  check('Shorts : et un verdict trop vieux l’y remet',
    (await db.listShortRecheck(t0 + db.SHORT_RECHECK_EVERY_MS + 1, 10))
      .includes('strict0001'));

  // Beyond the window nothing is asked again: a video of three days old that
  // YouTube has not reclassified will not be.
  check('Shorts : hors de la fenêtre, plus rien n’est redemandé',
    (await db.listShortRecheck(t0 + db.SHORT_RECHECK_WINDOW_MS + DAY, 10)).length === 0);

  await db.upsertVideos([
    { id: 'court00001', channelId: channelId(1), title: 'Assez courte pour être un Short',
      publishedAt: t0 - 5000, thumbUrl: 'https://e/6', durationSec: 18 },
  ]);
  check('Shorts : une vidéo de dix huit secondes est candidate',
    (await db.listShortCandidates(null, 500, 100000)).ids.includes('court00001'));

  // A Short is removed, not hidden: hidden, it would stay in the "hidden" view
  // and in the counters, which is already a presence.
  check('Shorts : la suppression rend le nombre retiré',
    (await db.deleteVideos(['court00001', 'inexistant1'])) === 1);
  check('Shorts : et la vidéo a bien quitté la base',
    !(await db.getFeedPage({ limit: 300 })).items.some((v) => v.id === 'court00001'));

  check('garde-fou : la vidéo complète passe', sans.has('strict0001'));
  check('garde-fou : une vidéo sans durée est retenue', !sans.has('strict0002'));
  check('garde-fou : un avatar manquant ne masque pas une publication', sans.has('strict0003'));
  check('garde-fou : un direct en cours passe sans durée', sans.has('strict0004'));
  check('garde-fou : une durée déclarée introuvable retient la vidéo', !sans.has('strict0005'));

  // The invariant that matters: everything that disappears is counted. A video
  // taken out of the feed with nothing saying so would be indistinguishable from
  // a video one had missed — the very defect the guard repairs.
  check('garde-fou : le compte couvre exactement ce qui disparaît',
    strict.withheldCount === avec.size - sans.size,
    { compte: strict.withheldCount, disparues: avec.size - sans.size });

  const retenues = new Set(strict.withheld.map((v) => v.id));
  check('garde-fou : les retenues sont rendues pour résolution',
    retenues.has('strict0002') && !retenues.has('strict0003'), [...retenues]);
  check('garde-fou : une vidéo introuvable n’est pas proposée à la résolution',
    !retenues.has('strict0005'));

  // The predicate itself, which the query and the grid both read.
  const avatars = new Set([channelId(1)]);
  check('garde-fou : le manque est nommé',
    videoIncomplete({ channelId: channelId(1), durationSec: 0 }, avatars) === 'duration'
    && videoIncomplete({ channelId: channelId(9), durationSec: 10 }, avatars) === null
    && videoIncomplete({ channelId: channelId(1), durationSec: 10 }, avatars) === null);

  check('garde-fou : un avatar porté par la vidéo suffit',
    videoIncomplete(
      { channelId: channelId(9), channelAvatar: 'https://e/a', durationSec: 10 }, avatars,
    ) === null);
}

/**
 * The options contract between the service worker and the feed query.
 *
 * This test exists for one precise bug: `onlyHidden` had been added to
 * `getFeedPage()` and to the interface, but forgotten in the copy the service
 * worker makes. The option was lost on the way, with no error, and the "Hidden"
 * view returned the normal feed. The base tests could not see it: they call
 * `getFeedPage()` directly.
 */
function testFeedOptionsContract(check) {
  const accepted = destructuredParamNames(db.getFeedPage);
  const transmitted = new Set(FEED_PAGE_OPTIONS);

  check('contrat : la signature de getFeedPage est bien lue',
    accepted.length > 3, accepted);

  const oubliees = accepted.filter((name) => !transmitted.has(name));
  check('contrat : aucune option acceptée n’est oubliée à la transmission',
    oubliees.length === 0, oubliees);

  const inventees = FEED_PAGE_OPTIONS.filter((name) => !accepted.includes(name));
  check('contrat : aucune option transmise n’est inconnue de la requête',
    inventees.length === 0, inventees);

  // The filtering itself: nothing foreign gets through, nothing absent is forced
  // to undefined — otherwise the default values would be overwritten.
  const filtre = pick({ type: 'feed:page', onlyHidden: true, limit: 10, inconnu: 1 }, FEED_PAGE_OPTIONS);
  check('contrat : les clés étrangères sont écartées',
    !('type' in filtre) && !('inconnu' in filtre), Object.keys(filtre));
  check('contrat : les options présentes passent', filtre.onlyHidden === true && filtre.limit === 10, filtre);
  check('contrat : les options absentes ne sont pas forcées à undefined',
    !('query' in filtre), Object.keys(filtre));
}

/**
 * The viewing sessions measured on the page.
 *
 * The sensitive point is not the writing, it is the identification. A session
 * sometimes arrives with no channel: YouTube's page takes a moment to say what
 * it is playing, and an internal navigation can catch it short. Those sessions
 * were lost to the analysis, which sets aside from all its rankings any line
 * with no channel — even though the database had known the video since the
 * subscription feed.
 */
async function testWatchSessions(check) {
  const connue = {
    id: 'vidwatch01', channelId: channelId(1), channelTitle: 'Chaîne 1',
    title: 'Vidéo déjà connue', publishedAt: BASE_TS, thumbUrl: 'https://example/w1',
  };
  await db.upsertVideos([connue]);

  const t0 = BASE_TS + 5 * DAY;
  let r = await db.putWatchSession({
    videoId: 'vidwatch01', watchedAt: t0, title: '', channelId: null,
    channelTitle: '', durationSec: 300, watchedSec: 100, completed: false,
  });
  check('séance : une première écriture crée la ligne', r.created === true, r);

  const ligne = () => db.getAllHistory().then(
    (all) => all.find((e) => e.key === `vidwatch01|${t0}`));

  let e = await ligne();
  check('séance : la chaîne est retrouvée dans la base',
    e?.channelId === channelId(1) && e?.title === 'Vidéo déjà connue', e);
  check('séance : elle n’est donc pas rangée parmi les vidéos disparues',
    e?.nonResolue === false, e?.nonResolue);

  // The reports that follow refine the measurement without multiplying rows.
  r = await db.putWatchSession({
    videoId: 'vidwatch01', watchedAt: t0, title: '', channelId: null,
    channelTitle: '', durationSec: 300, watchedSec: 240, completed: true,
  });
  e = await ligne();
  check('séance : un rapport plus tardif ne crée pas de doublon', r.created === false, r);
  check('séance : le temps regardé ne peut que croître', e?.watchedSec === 240, e?.watchedSec);

  // A video the database does not know yet: the session stays silent, and that
  // is the right behaviour as long as there is nothing to name it.
  const t1 = BASE_TS + 6 * DAY;
  await db.putWatchSession({
    videoId: 'vidwatch02', watchedAt: t1, title: '', channelId: null,
    channelTitle: '', durationSec: 120, watchedSec: 60, completed: false,
  });
  const orpheline = () => db.getAllHistory().then(
    (all) => all.find((e2) => e2.key === `vidwatch02|${t1}`));
  check('séance : sans rien pour la nommer, elle est marquée non résolue',
    (await orpheline())?.nonResolue === true, await orpheline());

  // The video then arrives by the feed: the catch-up pass recovers it.
  await db.upsertVideos([{
    id: 'vidwatch02', channelId: channelId(2), channelTitle: 'Chaîne 2',
    title: 'Vidéo arrivée après coup', publishedAt: BASE_TS, thumbUrl: 'https://example/w2',
  }]);
  const passe = await db.resolveOrphanSessions();
  check('rattrapage : la séance orpheline est rattachée', passe.resolved === 1, passe);
  const reparee = await orpheline();
  check('rattrapage : elle porte désormais sa chaîne',
    reparee?.channelId === channelId(2) && reparee?.nonResolue === false, reparee);

  const rien = await db.resolveOrphanSessions();
  check('rattrapage : une seconde passe n’a plus rien à faire', rien.resolved === 0, rien);

  await db.clearHistory();
}

function resetDatabase() {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(db.DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

const channelId = (n) => 'UC' + String(n).padStart(22, 'x');
const mkChannel = (n) => ({ id: channelId(n), title: `Chaîne ${n}`, avatarUrl: `https://example/${n}` });

// ---------------------------------------------------------------------------

async function testChannels(check) {
  let r = await db.reconcileChannels([mkChannel(1), mkChannel(2), mkChannel(3)]);
  check('reconcile : 3 chaînes ajoutées', r.added === 3 && r.deactivated === 0, r);

  // A partial read deactivates nothing at all, and that is the point: the list
  // is the same one, minus the channel, and only the flag separates the two
  // calls below.
  const tronquee = await db.reconcileChannels([mkChannel(1), mkChannel(2)]);
  check(
    'reconcile : une liste incomplète ne désactive rien',
    tronquee.deactivated === 0 && tronquee.deactivationSkipped === true,
    tronquee,
  );
  check('reconcile : la chaîne absente est toujours relue après une liste incomplète',
    (await db.getDueChannels(50)).length === 3);

  r = await db.reconcileChannels([mkChannel(1), mkChannel(2)], { complete: true });
  check(
    'reconcile : la chaîne absente est désactivée, pas supprimée',
    r.added === 0 && r.updated === 2 && r.deactivated === 1,
    r,
  );

  const due = await db.getDueChannels(50);
  check('getDueChannels ignore les chaînes inactives', due.length === 2, due.map((c) => c.id));
}

/**
 * Anchoring of the fixtures, deliberately far in the past.
 *
 * The sections that follow stack offsets (`BASE_TS + 200 days`) so that each
 * batch is more recent than the previous one. With an anchor close to today's
 * date, those offsets put the fixtures **in the future** — and since the feed
 * excludes scheduled broadcasts, they all disappeared, breaking some thirty
 * tests at once.
 */
const BASE_TS = Date.parse('2024-01-15T12:00:00Z');

/** Ten videos over four timestamps: the ties are deliberate. */
function fixtureVideos() {
  return Array.from({ length: 10 }, (_, i) => ({
    id: 'vid' + String(i).padStart(8, '0'),
    channelId: channelId(1),
    channelTitle: 'Chaîne 1',
    title: `Vidéo ${i}`,
    publishedAt: BASE_TS - Math.floor(i / 3) * HOUR,
    thumbUrl: `https://example/thumb/${i}`,
    views: i * 100,
  }));
}

async function testVideos(check) {
  const videos = fixtureVideos();

  const first = await db.upsertVideos(videos);
  check('upsert : 10 insertions', first.inserted === 10, first.inserted);

  const second = await db.upsertVideos(videos);
  check('upsert : idempotent, aucune réinsertion', second.inserted === 0, second.inserted);

  // The RSS has no durations; the native feed supplies them later. The second
  // source must not overwrite what the first established, and conversely a known
  // value must never fall back to null.
  await db.upsertVideos([{ ...videos[0], durationSec: 754 }]);
  await db.upsertVideos([{ ...videos[0], durationSec: null }]);
  const page = await db.getFeedPage({ limit: 50 });
  const enriched = page.items.find((v) => v.id === videos[0].id);
  check('upsert : une durée connue n’est pas écrasée par null', enriched?.durationSec === 754, enriched?.durationSec);

  // The view counter, on the other hand, has to follow. It never moved: the
  // engine skipped the write when the feed's fingerprint had not changed, and
  // that fingerprint deliberately ignores the views. A video therefore kept the
  // counter of its discovery, that is a few hundred views for a video ten
  // minutes old.
  await db.upsertVideos([{ ...videos[0], views: 12 }]);
  const bougees = await db.upsertVideos([{ ...videos[0], views: 48_000 }]);
  const relu = (await db.getFeedPage({ limit: 50 })).items.find((v) => v.id === videos[0].id);
  check('upsert : un compteur de vues plus récent remplace l’ancien',
    relu?.views === 48_000 && bougees.updated === 1, { views: relu?.views, updated: bougees.updated });

  // Regression: the native feed harvest often brings back nothing but a video id
  // read from the DOM, with no channelId. Requiring the channelId made the whole
  // harvest fail silently, and the audit never found anything.
  const marked = await db.upsertVideos([
    { id: videos[1].id, seenNativeAt: 1_700_000_000_000, durationSec: 300 },
  ]);
  check('upsert : un identifiant seul marque une vidéo existante',
    marked.updated === 1 && marked.inserted === 0, marked);
  check('upsert : le lot rapporte ce qu’il a marqué comme vu',
    marked.nativeMarked.count === 1 && marked.nativeMarked.oldestPublishedAt === videos[1].publishedAt,
    marked.nativeMarked);

  // The same record a second time must not count again.
  const again = await db.upsertVideos([{ id: videos[1].id, seenNativeAt: 1_700_000_001_000 }]);
  check('upsert : la première observation native fait foi', again.nativeMarked.count === 0, again.nativeMarked);

  // An unknown id with no channelId cannot create a row.
  const orphan = await db.upsertVideos([{ id: 'inconnu0000', seenNativeAt: Date.now() }]);
  check('upsert : un identifiant inconnu sans channelId est ignoré, pas inséré',
    orphan.inserted === 0 && orphan.skipped === 1, orphan);

  // The playback progress goes up but never comes back down.
  await db.upsertVideos([{ id: videos[2].id, watchProgress: 0.6 }]);
  await db.upsertVideos([{ id: videos[2].id, watchProgress: 0.2 }]);
  const progressed = (await db.getFeedPage({ limit: 50 })).items.find((v) => v.id === videos[2].id);
  check('upsert : la progression de lecture ne recule pas', progressed?.watchProgress === 0.6, progressed?.watchProgress);

  await db.upsertVideos([{ id: videos[2].id, watchProgress: 0.95 }]);
  const watched = (await db.getFeedPage({ limit: 50 })).items.find((v) => v.id === videos[2].id);
  check('upsert : au-delà de 90 % la vidéo passe en « vue »', watched?.watched === 1, watched?.watched);

  // The games compare what a channel does, not what we do with it: the
  // quantities below span orders of magnitude where hours watched never do.
  // They are read from the feed index, hence from `UULF`: no Short weighs on
  // a view total or on a mean duration.
  const faits = (await db.getChannelFacts()).get(channelId(1));
  check('faits de chaîne : les vidéos de l’index sont comptées',
    faits.videos === 10, faits.videos);
  check('faits de chaîne : les vues se cumulent',
    faits.views === 52_500, faits.views);
  check('faits de chaîne : la plus vue est retenue avec son titre',
    faits.bestViews === 48_000 && faits.bestTitle === 'Vidéo 0',
    [faits.bestViews, faits.bestTitle]);
  check('faits de chaîne : la durée moyenne ignore les vidéos sans durée',
    faits.durCount === 2 && faits.durTotal === 1054, [faits.durCount, faits.durTotal]);

  const recentIds = await db.getRecentVideoIdsByChannel(3);
  const recentForChannel = recentIds.get(channelId(1)) ?? [];
  check('rafraîchissement : les identifiants récents sont groupés en une lecture locale',
    recentForChannel.length === 3
    && ['vid00000000', 'vid00000001', 'vid00000002'].every((id) => recentForChannel.includes(id)),
    recentForChannel);
}

async function testPagination(check) {
  const seen = [];
  let cursor = null;
  let guard = 0;

  do {
    const page = await db.getFeedPage({ limit: 4, after: cursor });
    seen.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor && ++guard < 20);

  const ids = seen.map((v) => v.id);
  const unique = new Set(ids);

  check('pagination : aucun doublon', unique.size === ids.length, { vus: ids.length, uniques: unique.size });
  check('pagination : aucune vidéo manquée', unique.size === 10, unique.size);

  const ordered = seen.every((v, i) => i === 0 || seen[i - 1].publishedAt >= v.publishedAt);
  check('pagination : ordre antichronologique respecté', ordered);
}

async function testHiding(check) {
  await db.setHidden(['vid00000000', 'vid00000001', 'vid00000002'], true);

  const visible = await db.getFeedPage({ limit: 50 });
  check('masquage : les vidéos masquées disparaissent du feed', visible.items.length === 7, visible.items.length);

  const all = await db.getFeedPage({ limit: 50, includeHidden: true });
  check('includeHidden : les masquées restent accessibles', all.items.length === 10, all.items.length);

  const stats = await db.getStats();
  check('getStats : compteurs cohérents', stats.total === 10 && stats.visible === 7 && stats.hidden === 3, stats);

  await db.setHidden(['vid00000000'], false);
  const after = await db.getStats();
  check('démasquage : réversible', after.visible === 8, after.visible);

  const recent = await db.getVideosSince(BASE_TS - 30 * 60_000);
  check('getVideosSince : filtre bien par date', recent.length === 3, recent.length);
}

/**
 * The "never shown by the native feed" filter.
 *
 * The trap is in the paging: when the cursor sets aside many records, it must
 * still remember its real position. Otherwise the next page starts again from a
 * point already passed and loops without ever moving on.
 */
async function testUnseenFilter(check) {
  // Placed after the others so as to head the feed and not get mixed up with the
  // previous sections' videos.
  const base = BASE_TS + 30 * DAY;
  const batch = Array.from({ length: 8 }, (_, i) => ({
    id: 'unseen' + String(i).padStart(5, '0'),
    channelId: channelId(2),
    channelTitle: 'Chaîne 2',
    title: `Récente ${i}`,
    publishedAt: base + i * HOUR,
    thumbUrl: `https://example/u/${i}`,
    // One in two has been seen in YouTube's native feed.
    ...(i % 2 === 0 ? { seenNativeAt: Date.now() } : {}),
  }));
  await db.upsertVideos(batch);

  const page = await db.getFeedPage({ limit: 4, onlyUnseen: true });
  const ids = page.items.map((v) => v.id);
  check('filtre : ne retourne que les vidéos jamais affichées',
    ids.length === 4 && ids.every((id) => id.startsWith('unseen')) && page.items.every((v) => !v.seenNativeAt),
    ids);

  // Fine paging: two pages of 2, while the cursor has to skip the four "already
  // seen" records in between.
  const collected = [];
  let cursor = null;
  let guard = 0;
  do {
    const p = await db.getFeedPage({ limit: 2, after: cursor, onlyUnseen: true });
    collected.push(...p.items.map((v) => v.id));
    cursor = p.nextCursor;
  } while (cursor && ++guard < 10);

  const unique = new Set(collected);
  check('filtre : pagination sans doublon malgré les enregistrements écartés',
    unique.size === collected.length, { vus: collected.length, uniques: unique.size });
  check('filtre : la pagination progresse et se termine', guard < 10, { tours: guard });
  check('filtre : les 4 vidéos non affichées sont toutes retrouvées',
    [...unique].filter((id) => id.startsWith('unseen')).length === 4, [...unique]);

  // Without the filter, the whole batch stays visible.
  const all = await db.getFeedPage({ limit: 8 });
  check('sans filtre : les 8 vidéos du lot sont là',
    all.items.filter((v) => v.id.startsWith('unseen')).length === 8,
    all.items.length);
}

/**
 * Search and statistics.
 *
 * The accent is the sensitive point: in French, typing "nucleaire" has to find
 * "nucléaire", otherwise the search is unusable.
 */
async function testSearchAndCounts(check) {
  const base = BASE_TS + 60 * DAY;
  await db.reconcileChannels([mkChannel(1), mkChannel(2), mkChannel(3)]);

  await db.upsertVideos([
    { id: 'srch00000a', channelId: channelId(3), channelTitle: 'ScienceÉtonnante',
      title: 'Fusion nucléaire à Grenoble', publishedAt: base + 3 * HOUR, thumbUrl: 'https://e/1' },
    { id: 'srch00000b', channelId: channelId(3), channelTitle: 'ScienceÉtonnante',
      title: 'Le café du matin', publishedAt: base + 2 * HOUR, thumbUrl: 'https://e/2' },
    { id: 'srch00000c', channelId: channelId(1), channelTitle: 'Chaîne 1',
      title: 'Une fusion de deux galaxies', publishedAt: base + HOUR, thumbUrl: 'https://e/3' },
  ]);

  const byTitle = await db.getFeedPage({ limit: 50, query: 'fusion' });
  check('recherche : deux titres contiennent « fusion »',
    byTitle.items.filter((v) => v.id.startsWith('srch')).length === 2,
    byTitle.items.map((v) => v.id));

  const noAccent = await db.getFeedPage({ limit: 50, query: 'nucleaire' });
  check('recherche : insensible aux accents',
    noAccent.items.some((v) => v.id === 'srch00000a'), noAccent.items.map((v) => v.id));

  const accented = await db.getFeedPage({ limit: 50, query: 'ÉTONNANTE' });
  check('recherche : insensible à la casse et aux accents sur le nom de chaîne',
    accented.items.filter((v) => v.id.startsWith('srch')).length === 2,
    accented.items.map((v) => v.id));

  const multi = await db.getFeedPage({ limit: 50, query: 'grenoble fusion' });
  check('recherche : tous les mots doivent être présents, l’ordre est libre',
    multi.items.length === 1 && multi.items[0].id === 'srch00000a',
    multi.items.map((v) => v.id));

  const none = await db.getFeedPage({ limit: 50, query: 'introuvable-xyz' });
  check('recherche : aucun résultat plutôt qu’une erreur', none.items.length === 0);

  const byChannel = await db.getFeedPage({ limit: 50, channelId: channelId(3) });
  check('filtre par chaîne : ne retourne que cette chaîne',
    byChannel.items.length === 2 && byChannel.items.every((v) => v.channelId === channelId(3)),
    byChannel.items.map((v) => v.id));

  const combined = await db.getFeedPage({ limit: 50, channelId: channelId(3), query: 'café' });
  check('filtre par chaîne + recherche se combinent',
    combined.items.length === 1 && combined.items[0].id === 'srch00000b',
    combined.items.map((v) => v.id));

  // -- statistiques
  const counts = await db.getFeedCounts([1, 7, 30]);
  const visible = (await db.getFeedPage({ limit: 1000 })).items.length;
  check('stats : le total colle au nombre de vidéos visibles',
    counts.total === visible, { compte: counts.total, listees: visible });
  check('stats : les tranches sont croissantes',
    counts.byPeriod[1] <= counts.byPeriod[7] && counts.byPeriod[7] <= counts.byPeriod[30]
    && counts.byPeriod[30] <= counts.total, counts.byPeriod);

  // Hidden videos must never enter the count.
  await db.setHidden(['srch00000b'], true);
  const after = await db.getFeedCounts([30]);
  check('stats : le masquage décrémente le total', after.total === counts.total - 1,
    { avant: counts.total, apres: after.total });
  await db.setHidden(['srch00000b'], false);
}

/**
 * Comfort filters: views, minimum duration, age.
 *
 * The point not to break: a video marked as a priority escapes them. It has been
 * explicitly pointed at, and it would be absurd for a setting to make it
 * disappear.
 */
async function testComfortFilters(check) {
  const base = BASE_TS + 200 * DAY;
  const ids = { vue: 'conf000001', courte: 'conf000002', vieille: 'conf000003', normale: 'conf000004', prio: 'conf000005' };

  await db.upsertVideos([
    { id: ids.vue, channelId: channelId(1), title: 'Déjà regardée', publishedAt: base, thumbUrl: 'https://e/1' },
    { id: ids.courte, channelId: channelId(1), title: 'Très courte', publishedAt: base, thumbUrl: 'https://e/2', durationSec: 45 },
    { id: ids.vieille, channelId: channelId(1), title: 'Ancienne', publishedAt: Date.now() - 60 * DAY, thumbUrl: 'https://e/3' },
    { id: ids.normale, channelId: channelId(1), title: 'Normale', publishedAt: base, thumbUrl: 'https://e/4', durationSec: 900 },
    { id: ids.prio, channelId: channelId(1), title: 'Prioritaire vue et courte', publishedAt: base, thumbUrl: 'https://e/5', durationSec: 30 },
  ]);
  await db.setWatched(ids.vue, 1, true);
  await db.setWatched(ids.prio, 1, true);
  await db.setStarred([ids.prio], true);

  const has = (page, id) => page.items.some((v) => v.id === id);

  const vues = await db.getFeedPage({ limit: 300, hideWatched: true });
  check('filtre : une vidéo regardée disparaît', !has(vues, ids.vue));
  check('filtre : les autres restent', has(vues, ids.normale));

  const courtes = await db.getFeedPage({ limit: 300, minDurationSec: 120 });
  check('filtre : une vidéo trop courte disparaît', !has(courtes, ids.courte));
  check('filtre : une durée inconnue ne fait pas disparaître la vidéo',
    has(courtes, ids.vue), 'durée nulle = on ne sait pas, donc on garde');

  const recentes = await db.getFeedPage({ limit: 300, maxAgeDays: 7 });
  check('filtre : une vidéo trop ancienne disparaît', !has(recentes, ids.vieille));

  const tout = await db.getFeedPage({ limit: 300, hideWatched: true, minDurationSec: 300, maxAgeDays: 7 });
  check('filtre : une vidéo prioritaire échappe à tous les filtres', has(tout, ids.prio));
  check('filtre : les trois filtres se combinent',
    !has(tout, ids.vue) && !has(tout, ids.courte) && !has(tout, ids.vieille));

  // Position and "watched" status are two distinct things: that is what stops a
  // video being marked watched by dragging the cursor to the end.
  const id6 = 'conf000006';
  await db.upsertVideos([{ id: id6, channelId: channelId(1), title: 'À moitié', publishedAt: base, thumbUrl: 'https://e/6' }]);

  await db.setWatched(id6, 0.4, false);
  check('suivi : une lecture partielle laisse la vidéo dans le feed',
    has(await db.getFeedPage({ limit: 300, hideWatched: true }), id6));

  // Cursor dragged to the end, but nothing actually watched.
  await db.setWatched(id6, 0.99, false);
  const apresSaut = await db.getFeedPage({ limit: 300, hideWatched: true });
  check('suivi : glisser le curseur à la fin ne suffit pas', has(apresSaut, id6));
  check('suivi : la position est quand même enregistrée pour la barre rouge',
    apresSaut.items.find((v) => v.id === id6)?.watchProgress === 0.99);

  await db.setWatched(id6, 0.99, true);
  check('suivi : la vidéo réellement parcourue sort du feed',
    !has(await db.getFeedPage({ limit: 300, hideWatched: true }), id6));

  // -- replays of lives
  const rediff = 'rediff00001';
  const direct = 'direct00001';
  const rediffPrio = 'rediff00002';
  await db.upsertVideos([
    { id: rediff, channelId: channelId(1), title: 'Direct de mardi', publishedAt: base, thumbUrl: 'https://e/7', wasLive: true, durationSec: 7200 },
    { id: direct, channelId: channelId(1), title: 'En cours', publishedAt: base, thumbUrl: 'https://e/8', wasLive: true, isLive: true },
    { id: rediffPrio, channelId: channelId(1), title: 'Direct gardé', publishedAt: base, thumbUrl: 'https://e/9', wasLive: true, durationSec: 3600 },
  ]);
  await db.setStarred([rediffPrio], true);

  const sansRediff = await db.getFeedPage({ limit: 300, hideReplays: true });
  check('rediffusions : une rediffusion disparaît', !has(sansRediff, rediff));
  check('rediffusions : un direct en cours reste', has(sansRediff, direct));
  check('rediffusions : une vidéo ordinaire n’est pas touchée', has(sansRediff, ids.normale));
  check('rediffusions : une rediffusion prioritaire échappe au filtre', has(sansRediff, rediffPrio));
  check('rediffusions : sans le réglage, tout reste',
    has(await db.getFeedPage({ limit: 300 }), rediff));

  // A broadcast is looked for in the lives playlist, never in the long videos
  // one where it is not.
  const attente = 'rediff00003';
  await db.upsertVideos([
    { id: attente, channelId: channelId(1), title: 'Direct sans durée', publishedAt: base, thumbUrl: 'https://e/10', wasLive: true },
  ]);
  const groups = await db.getMissingDurationsByChannel(20);
  const group = groups.find((g) => g.channelId === channelId(1));
  check('durées : les diffusions sont séparées des vidéos',
    group?.liveIds.includes(attente) && !group?.ids.includes(attente),
    { ids: group?.ids.length, liveIds: group?.liveIds });

  // The state is rewritten whole: what is no longer in the list goes out,
  // otherwise a live read once would stay one forever.
  await db.setBroadcastStates({ live: [attente], checked: [direct, attente] });
  const apresReleve = await db.getFeedPage({ limit: 300, hideLives: true });
  check('directs : l’état s’allume sur la diffusion en cours', !has(apresReleve, attente));
  check('directs : et s’éteint sur celle qui n’est plus relevée', has(apresReleve, direct));

  // The heart of the classification: with no duration, a broadcast is not a
  // replay. Confusing it with one filled the feed with zero view appointments
  // carrying the REPLAY label.
  check('rediffusions : une diffusion sans durée n’en est pas une',
    has(await db.getFeedPage({ limit: 300, hideReplays: true }), direct));

  // Nor is it an appointment as long as nobody has read its state. Deducing that
  // from the absence of a duration gave thumbnails several days old announced as
  // not yet having happened, since the Atom feed never carries a duration. With
  // no measurement we conclude nothing, and it is the guard that withholds the
  // video until we know.
  check('diffusions : sans relevé, une durée absente ne fait pas un rendez-vous',
    has(await db.getFeedPage({ limit: 300, hideUpcoming: true }), direct));
  check('diffusions : le garde-fou la retient tant que sa durée manque',
    !has(await db.getFeedPage({ limit: 300, requireComplete: true }), direct));

  await db.setDurations(new Map([[attente, 5400]]));
  check('directs : une durée connue éteint le direct',
    !has(await db.getFeedPage({ limit: 300, hideReplays: true }), attente));

  // A live from the day before left the missing durations window before ending:
  // nothing was going to read its state again, and it announced itself "live"
  // forever. The hunt for broadcasts does not look at the date, only at the
  // state.
  const vieuxDirect = 'direct00002';
  await db.upsertVideos([{
    id: vieuxDirect, channelId: channelId(2), title: 'Direct de la NASA',
    publishedAt: base - 400 * 24 * 3600 * 1000, thumbUrl: 'https://e/11',
    wasLive: true, isLive: true,
  }]);

  const horsFenetre = await db.getMissingDurationsByChannel(20, 5);
  check('diffusions : la quête des durées ne voit pas un direct ancien',
    !horsFenetre.some((g) => g.liveIds.includes(vieuxDirect)), horsFenetre.length);

  const actives = await db.getActiveBroadcasts(20);
  check('diffusions : la quête dédiée le retrouve quelle que soit sa date',
    actives.some((g) => g.liveIds.includes(vieuxDirect)), actives);
  check('diffusions : et elle les range comme des diffusions',
    actives.every((g) => !g.ids.length), actives);

  await db.setBroadcastStates({ checked: [vieuxDirect] });
  check('diffusions : éteinte, elle sort de la quête',
    !(await db.getActiveBroadcasts(20)).some((g) => g.liveIds.includes(vieuxDirect)));
}

/**
 * Premieres and scheduled lives.
 *
 * A video dated in the future planted itself at the top of the feed and stayed
 * there until it aired — the most widespread complaint about the subscriptions
 * feed.
 */
async function testUpcoming(check) {
  const has = (page, id) => page.items.some((v) => v.id === id);
  const dans2h = Date.now() + 2 * HOUR;
  const dans3j = Date.now() + 3 * DAY;

  await db.upsertVideos([
    { id: 'soon00000a', channelId: channelId(1), title: 'Première dans 3 jours',
      publishedAt: dans3j, thumbUrl: 'https://e/a' },
    { id: 'soon00000b', channelId: channelId(1), title: 'Live dans 2 heures',
      publishedAt: dans2h, thumbUrl: 'https://e/b' },
  ]);

  const feed = await db.getFeedPage({ limit: 300, hideUpcoming: true });
  check('à venir : absentes du feed principal',
    !feed.items.some((v) => v.id.startsWith('soon')), feed.items.slice(0, 2).map((v) => v.id));
  check('à venir : le feed commence bien par une vidéo déjà publiée',
    feed.items[0].publishedAt <= Date.now(), new Date(feed.items[0].publishedAt).toISOString());

  const counts = await db.getFeedCounts([1, 7]);
  check('compteurs : les programmées sont comptées à part', counts.upcoming === 2, counts.upcoming);
  check('compteurs : elles ne gonflent pas les dernières 24 h',
    counts.byPeriod[1] < counts.total, { j1: counts.byPeriod[1], total: counts.total });

  // Hiding a scheduled one must take it out of the feed, even when asked for explicitly.
  await db.setHidden(['soon00000a'], true);
  check('à venir : une programmée masquée reste masquée',
    !has(await db.getFeedPage({ limit: 300, hideUpcoming: false }), 'soon00000a'));
  await db.setHidden(['soon00000a'], false);

  // The chronological feed sets them aside by default, but whoever asks for them
  // must get them: without lifting the bound, only those whose time is unknown
  // appeared, which is exactly the opposite of useful.
  const avecPrevues = await db.getFeedPage({ limit: 300, hideUpcoming: false });
  check('à venir : demandées explicitement, elles entrent dans le fil',
    has(avecPrevues, 'soon00000a') && has(avecPrevues, 'soon00000b'));

  // -- scheduled broadcasts arriving by the lives playlist
  //
  // These carry the announcement's creation date, not the appointment's: left
  // untreated they file themselves into the feed's past, shown as replays, when
  // there is nothing to watch yet.
  const prevuDate = 'prevu000001';
  const prevuSansDate = 'prevu000002';
  const debut = Date.now() + 2 * DAY;
  // Recently dated: an announcement is published a few days before the
  // appointment, and it is that window "Upcoming" sweeps to catch up those whose
  // time stays unknown.
  const annonce = Date.now() - 2 * DAY;
  await db.upsertVideos([
    { id: prevuDate, channelId: channelId(1), title: 'Rendez-vous de jeudi',
      publishedAt: annonce, thumbUrl: 'https://e/c', wasLive: true },
    { id: prevuSansDate, channelId: channelId(1), title: 'Annonce sans heure',
      publishedAt: annonce, thumbUrl: 'https://e/d', wasLive: true },
  ]);

  await db.setBroadcastStates({
    upcoming: [[prevuDate, debut], [prevuSansDate, 0]],
    checked: [prevuDate, prevuSansDate],
  });

  check('programmées : l’heure annoncée devient la date de la vidéo',
    (await db.getFeedPage({ limit: 300, hideUpcoming: false })).items
      .find((v) => v.id === prevuDate)?.publishedAt === debut);
  check('programmées : datée, elle quitte le fil chronologique',
    !has(await db.getFeedPage({ limit: 300, hideUpcoming: true }), prevuDate));
  check('programmées : et revient si on la demande, avec sa date',
    has(await db.getFeedPage({ limit: 300, hideUpcoming: false }), prevuDate));
  check('programmées : sans heure connue, le réglage la retire du fil',
    !has(await db.getFeedPage({ limit: 300, hideUpcoming: true }), prevuSansDate));
  check('programmées : sans heure connue, elle revient si on les demande',
    has(await db.getFeedPage({ limit: 300, hideUpcoming: false }), prevuSansDate));
  check('programmées : le filtre des rediffusions ne les confond pas avec elles',
    has(await db.getFeedPage({ limit: 300, hideReplays: true }), prevuSansDate));

  // The appointment has taken place: the duration closes it, otherwise it would
  // stay "upcoming" indefinitely.
  await db.setDurations(new Map([[prevuSansDate, 4200]]));
  check('programmées : une durée connue met fin à l’attente',
    has(await db.getFeedPage({ limit: 300, hideUpcoming: true }), prevuSansDate));
}

/**
 * Backup and restore.
 *
 * The case that really matters: restoring onto an empty database. The videos
 * resynchronise from the feeds, but the triage work does not rebuild itself. The
 * states must therefore wait for the videos to arrive and apply themselves to
 * them.
 */
async function testBackup(check) {
  const id = 'bkp0000001';
  const beforeBackup = await db.getChannel(channelId(1));
  await db.putChannel({ ...beforeBackup, directBackfillAt: Date.now() });
  await db.upsertVideos([{
    id, channelId: channelId(1), channelTitle: 'Chaîne 1', title: 'À sauvegarder',
    publishedAt: BASE_TS, thumbUrl: 'https://e/b',
  }]);
  await db.setHidden([id], true);

  // A channel deliberately left in the triage. It is in the backup, inactive,
  // and that is the whole point of the case.
  await db.putChannel({ ...db.makeChannel(channelId(4), 'Quittée', ''), active: 0 });

  await db.putHistory([{
    videoId: 'histo00001', watchedAt: BASE_TS, title: 'Vue',
    channelId: channelId(1), channelTitle: 'Chaîne 1',
  }]);
  await db.settleHistoryVideos({ durations: [{ videoId: 'histo00001', sec: 640 }] });

  const dump = await db.exportUserData();
  check('export : format identifiable',
    dump.format === 'tracktube-backup' && dump.version === 2, dump.version);
  check('export : les abonnements sont inclus', dump.channels.length >= 3, dump.channels.length);
  // Version 1 exported the flags alone, and a restore then waited for a
  // collection to bring the video back — four hundred states in the air on a
  // real profile. The record itself is what makes a restore immediate.
  check('export : la vidéo est sauvegardée entière, pas seulement son état',
    dump.videos.some((v) => v.id === id && v.hidden === 1 && v.publishedAt === BASE_TS));
  check('export : les vidéos sans état ne sont pas exportées',
    dump.videos.every((v) => v.hidden || v.starred || v.watched || v.watchProgress),
    dump.videos.length);
  check('export : l’historique importé est dedans',
    dump.history.some((e) => e.videoId === 'histo00001'), dump.history.length);
  check('export : les durées aussi, elles coûtent une requête chacune',
    dump.durations.some((d) => d.videoId === 'histo00001' && d.sec === 640));

  let refuse = false;
  try { await db.importUserData({ format: 'autre-chose' }); } catch { refuse = true; }
  check('import : un fichier étranger est refusé', refuse);

  // Restoring onto an empty database: the real case, a profile lost or an
  // extension reinstalled.
  await resetDatabase();
  const etapes = [];
  const restore = await db.importUserData(dump, {
    onProgress: (p) => etapes.push(p), sliceSize: 2,
  });

  check('import : les abonnements sont recréés', restore.channels >= 3, restore.channels);
  check('import : la vidéo revient sans attendre une collecte',
    restore.created === dump.videos.length && restore.pending === 0,
    [restore.created, dump.videos.length, restore.pending]);
  check('import : l’historique est restauré', restore.history >= 1, restore.history);
  check('import : les durées sont restaurées', restore.durations >= 1, restore.durations);

  const visible = await db.getFeedPage({ limit: 50 });
  const avecMasquees = await db.getFeedPage({ limit: 50, onlyHidden: true });
  check('import : la vidéo revient bien masquée',
    !visible.items.some((v) => v.id === id) && avecMasquees.items.some((v) => v.id === id));

  // The restore went through `reconcileChannels`, which reactivates everything
  // it is handed — right for an import from YouTube, wrong for a backup. On a
  // real profile nine hundred and ten subscriptions came back where four
  // hundred remained, and two weeks of triage were undone.
  const apres = await db.getAllChannels();
  check('import : une chaîne quittée n’est pas ressuscitée',
    apres.find((c) => c.id === channelId(4))?.active === 0,
    apres.find((c) => c.id === channelId(4))?.active);
  check('import : le prochain balayage reconstruit les vidéos ordinaires omises du fichier',
    apres.find((c) => c.id === channelId(1))?.directBackfillAt === 0,
    apres.find((c) => c.id === channelId(1))?.directBackfillAt);

  const fin = etapes.at(-1);
  check('import : la progression avance et finit à 100 %',
    etapes.length > 2 && fin.done === fin.total && fin.total > 0, fin);

  // A version 1 file stays readable, and what it cannot fill waits as before.
  const v1 = await db.importUserData({
    format: 'tracktube-backup',
    version: 1,
    channels: [],
    videoStates: [{ id: 'bkp0000002', hidden: 1 }],
    watchSessions: [],
  });
  check('import : une sauvegarde v1 reste lisible', v1.version === 1, v1.version);
  check('import : un état v1 sans vidéo attend la collecte', v1.pending === 1, v1.pending);

  const revenu = await db.upsertVideos([{
    id: 'bkp0000002', channelId: channelId(1), title: 'Autre',
    publishedAt: BASE_TS, thumbUrl: 'https://e/c',
  }]);
  check('import : l’état v1 est réappliqué à l’arrivée de la vidéo',
    revenu.restored === 1, revenu.restored);
}

/** Avatar catch-up and hiding by channel. */
async function testChannelOperations(check) {
  // -- avatars
  await db.putChannel({
    ...db.makeChannel(channelId(7), 'Sans avatar', ''),
  });
  await db.putChannel({
    ...db.makeChannel(channelId(8), 'Avec avatar', 'https://example/deja.jpg'),
  });

  const filled = await db.fillMissingAvatars([
    [channelId(7), 'https://example/rattrape.jpg'],
    [channelId(8), 'https://example/autre.jpg'],
    [channelId(9), 'https://example/inconnu.jpg'], // chaîne inexistante
    [channelId(1), ''],                            // valeur vide : ignorée
  ]);
  check('avatars : seul celui qui manquait est complété', filled === 1, filled);

  const c7 = await db.getChannel(channelId(7));
  const c8 = await db.getChannel(channelId(8));
  check('avatars : le manquant est rempli', c7.avatarUrl === 'https://example/rattrape.jpg', c7.avatarUrl);
  check('avatars : un avatar connu n’est jamais écrasé', c8.avatarUrl === 'https://example/deja.jpg', c8.avatarUrl);

  const replaced = await db.fillMissingAvatars([
    [channelId(8), 'https://example/frais.jpg'],
  ], { replace: true });
  const c8Fresh = await db.getChannel(channelId(8));
  check('avatars : une réponse authentifiée remplace une adresse expirée',
    replaced === 1 && c8Fresh.avatarUrl === 'https://example/frais.jpg',
    { replaced, avatarUrl: c8Fresh.avatarUrl });

  const copiedAccountAvatar = 'https://yt3.googleusercontent.com/account=s176-c-k-c0x00ffffff-no-rj';
  await db.putChannel({ ...(await db.getChannel(channelId(7))), avatarUrl: copiedAccountAvatar });
  await db.putChannel({ ...(await db.getChannel(channelId(8))), avatarUrl: copiedAccountAvatar });
  await db.putChannel(db.makeChannel(channelId(9), 'Troisième chaîne', copiedAccountAvatar));
  const clearedShared = await db.dropSharedChannelAvatars();
  const clearedChannels = await Promise.all([7, 8, 9].map((n) => db.getChannel(channelId(n))));
  check('avatars : la photo du compte copiée sur plusieurs chaînes est supprimée',
    clearedShared === 3 && clearedChannels.every((channel) => !channel.avatarUrl),
    { clearedShared, avatars: clearedChannels.map((channel) => channel.avatarUrl) });

  // -- hiding by channel
  const base = BASE_TS + 90 * DAY;
  await db.upsertVideos([
    { id: 'chan00000a', channelId: channelId(7), channelTitle: 'Sans avatar', title: 'A',
      publishedAt: base + 2 * HOUR, thumbUrl: 'https://e/a' },
    { id: 'chan00000b', channelId: channelId(7), channelTitle: 'Sans avatar', title: 'B',
      publishedAt: base + HOUR, thumbUrl: 'https://e/b' },
    { id: 'chan00000c', channelId: channelId(8), channelTitle: 'Avec avatar', title: 'C',
      publishedAt: base, thumbUrl: 'https://e/c' },
  ]);

  const hiddenIds = await db.hideChannelVideos(channelId(7));
  check('masquage par chaîne : renvoie les identifiants masqués',
    hiddenIds.length === 2 && hiddenIds.every((id) => id.startsWith('chan')), hiddenIds);

  const remaining = await db.getFeedPage({ limit: 50, channelId: channelId(7) });
  check('masquage par chaîne : plus rien de visible pour cette chaîne',
    remaining.items.length === 0, remaining.items.length);

  const other = await db.getFeedPage({ limit: 50, channelId: channelId(8) });
  check('masquage par chaîne : les autres chaînes sont intactes',
    other.items.length === 1, other.items.length);

  // The rollback has to be exact: these ids feed the undo.
  await db.setHidden(hiddenIds, false);
  const restored = await db.getFeedPage({ limit: 50, channelId: channelId(7) });
  check('masquage par chaîne : annulable à l’identique', restored.items.length === 2, restored.items.length);

  const again = await db.hideChannelVideos(channelId(7));
  await db.setHidden(again, false);
  const twice = await db.hideChannelVideos(channelId(7));
  check('masquage par chaîne : idempotent, ne recompte pas les déjà masquées',
    twice.length === 2, twice.length);

  // The opposite gesture, indispensable in the bin view: one may have hidden a
  // whole channel there by mistake.
  const rendues = await db.hideChannelVideos(channelId(7), false);
  check('démasquage par chaîne : tout revient', rendues.length === 2, rendues.length);
  check('démasquage par chaîne : rien à faire au second passage',
    (await db.hideChannelVideos(channelId(7), false)).length === 0);

  // -- priorities by channel, and global reset
  const priorisees = await db.setChannelStarred(channelId(7), true);
  check('priorités par chaîne : appliquées', priorisees.length === 2, priorisees.length);
  check('priorités par chaîne : visibles dans la vue dédiée',
    (await db.getFeedPage({ limit: 300, onlyStarred: true })).items
      .filter((v) => v.channelId === channelId(7)).length === 2);

  const retirees = await db.setChannelStarred(channelId(7), false);
  check('priorités par chaîne : retirables', retirees.length === 2, retirees.length);

  // The global reset goes through the selection, not through a dedicated
  // function: "Select all" then "Remove from priorities" already does the work,
  // and it is the only path the interface offers.
  await db.setChannelStarred(channelId(7), true);
  await db.setStarred(['chan00000c'], true);
  const tout = (await db.getFeedPage({ limit: 300, onlyStarred: true })).items.map((v) => v.id);
  check('priorités : la sélection les voit toutes, toutes chaînes confondues',
    tout.length >= 3, tout.length);
  await db.setStarred(tout, false);
  check('priorités : la sélection les retire toutes',
    (await db.getFeedPage({ limit: 300, onlyStarred: true })).items.length === 0);
  check('priorités : les vidéos elles-mêmes sont intactes',
    (await db.getFeedPage({ limit: 300 })).items.length > 0);

  // -- deletion by channel, what happens on an unsubscribe
  await db.upsertVideos([
    { id: 'desab00000', channelId: channelId(9), channelTitle: 'Quittée', title: 'Visible',
      publishedAt: base + 3 * HOUR, thumbUrl: 'https://e/d1' },
    { id: 'desab00001', channelId: channelId(9), channelTitle: 'Quittée', title: 'Masquée',
      publishedAt: base + 4 * HOUR, thumbUrl: 'https://e/d2' },
  ]);
  await db.setHidden(['desab00001'], true);

  const supprimees = await db.deleteChannelVideos(channelId(9));
  check('désabonnement : toutes les vidéos partent, masquées comprises',
    supprimees === 2, supprimees);
  check('désabonnement : plus rien dans le feed',
    (await db.getFeedPage({ limit: 50, channelId: channelId(9) })).items.length === 0);
  // The bin is a view of the feed like any other: a deleted video must not
  // survive there either.
  check('désabonnement : plus rien dans la corbeille',
    (await db.getFeedPage({ limit: 50, channelId: channelId(9), onlyHidden: true })).items.length === 0);
  check('désabonnement : les autres chaînes sont intactes',
    (await db.getFeedPage({ limit: 50, channelId: channelId(8) })).items.length === 1);
  check('désabonnement : rien à supprimer au second passage',
    (await db.deleteChannelVideos(channelId(9))) === 0);

  // -- grouping of the missing durations, as the enrichment asks for it
  await db.upsertVideos([
    { id: 'duree00000', channelId: channelId(10), channelTitle: 'Durées', title: 'A',
      publishedAt: base + 5 * HOUR, thumbUrl: 'https://e/u1' },
    { id: 'duree00001', channelId: channelId(10), channelTitle: 'Durées', title: 'B',
      publishedAt: base + 6 * HOUR, thumbUrl: 'https://e/u2' },
    { id: 'duree00002', channelId: channelId(11), channelTitle: 'Durées bis', title: 'C',
      publishedAt: base + 7 * HOUR, thumbUrl: 'https://e/u3', durationSec: 600 },
  ]);

  // -- adjustable sweep period
  // A channel's rhythm no longer enters the computation: that is the whole point
  // of the sweep. A daily channel and a yearly one are read again at exactly the
  // same frequency, the one the user has chosen.
  const quotidienne = { uploadIntervalMs: DAY, lastUploadAt: Date.now() };
  const annuelle = { uploadIntervalMs: 365 * DAY, lastUploadAt: Date.now() };
  check('balayage : la fréquence de publication ne change rien',
    sch.computeInterval(quotidienne) === sch.computeInterval(annuelle),
    { quot: sch.computeInterval(quotidienne), an: sch.computeInterval(annuelle) });

  // The floor sits at ten minutes, just under the cache: below that a read can
  // bring nothing back at all, and the phase locking already covers the cases
  // where the copy has expired early.
  check('balayage : le plancher tient même si on demande plus vite',
    sch.computeInterval(quotidienne, Date.now(), { sweepMs: 60_000 }) === sch.SWEEP_MIN,
    sch.computeInterval(quotidienne, Date.now(), { sweepMs: 60_000 }));

  // -- subscriber counts, as the subscriptions list delivers them
  const compact = [
    ['1,07 M d’abonnés', 1_070_000],
    ['1.07M subscribers', 1_070_000],
    ['12,3 k abonnés', 12_300],
    ['845 abonnés', 845],
    ['2,4 Md d’abonnés', 2_400_000_000],
    ['1 234 abonnés', 1234],
  ];
  for (const [texte, attendu] of compact) {
    check(`abonnés : « ${texte} » → ${attendu}`, parseCompactCount(texte) === attendu, parseCompactCount(texte));
  }
  check('abonnés : texte vide rejeté', parseCompactCount('') === null);
  check('abonnés : poignée rejetée', parseCompactCount('@1nonly') === null, parseCompactCount('@1nonly'));

  // -- reconciliation: what disappears from the YouTube list
  // Complete, like the two calls it frames: this section measures the removal
  // itself, and a partial list would now deactivate nothing at all.
  const avant = await db.reconcileChannels([
    { id: channelId(20), title: 'Gardée' },
    { id: channelId(21), title: 'Quittée ailleurs' },
  ], { complete: true });
  check('réconciliation : deux chaînes connues', avant.added === 2, avant);

  const apresRetrait = await db.reconcileChannels(
    [{ id: channelId(20), title: 'Gardée' }], { complete: true });
  check('réconciliation : la chaîne absente est désactivée',
    apresRetrait.deactivated === 1, apresRetrait.deactivated);
  // The ids are indispensable: without them, the caller cannot purge the videos
  // of the channels no longer followed.
  check('réconciliation : les identifiants désactivés sont renvoyés',
    apresRetrait.deactivatedIds?.includes(channelId(21)), apresRetrait.deactivatedIds);

  const groups = await db.getMissingDurationsByChannel(20);
  const g10 = groups.find((g) => g.channelId === channelId(10));
  check('durées : les vidéos sans durée sont groupées par chaîne',
    g10?.ids.length === 2, g10?.ids);
  check('durées : une chaîne déjà renseignée n’apparaît pas',
    !groups.some((g) => g.channelId === channelId(11)));

  // One request per channel: the ceiling has to be honoured, otherwise the
  // enrichment would query the internal API hundreds of times in a row.
  check('durées : le nombre de chaînes par lot est plafonné',
    (await db.getMissingDurationsByChannel(1)).length <= 1);

  await db.setDurations(new Map([['duree00000', 123]]));
  const apres = await db.getMissingDurationsByChannel(20);
  check('durées : une vidéo renseignée sort du lot',
    !apres.find((g) => g.channelId === channelId(10))?.ids.includes('duree00000'));
}

/** Priorities: the opposite of hiding. */
async function testStarring(check) {
  const base = BASE_TS + 120 * DAY;
  const ids = ['star00000a', 'star00000b', 'star00000c'];
  await db.upsertVideos(ids.map((id, i) => ({
    id,
    channelId: channelId(1),
    channelTitle: 'Chaîne 1',
    title: `Priorité ${i}`,
    publishedAt: base + i * HOUR,
    thumbUrl: `https://e/s${i}`,
  })));

  const changed = await db.setStarred([ids[0], ids[1]], true);
  check('priorité : deux vidéos marquées', changed === 2, changed);

  const again = await db.setStarred([ids[0]], true);
  check('priorité : remarquer ne change rien', again === 0, again);

  const only = await db.getFeedPage({ limit: 50, onlyStarred: true });
  check('priorité : le filtre ne retourne que les marquées',
    only.items.length === 2 && only.items.every((v) => v.starred === 1),
    only.items.map((v) => v.id));

  // An invisible priority would make no sense: marking unhides.
  await db.setHidden([ids[2]], true);
  const hiddenBefore = (await db.getFeedCounts([1])).hidden;
  await db.setStarred([ids[2]], true);
  const restored = await db.getFeedPage({ limit: 50, onlyStarred: true });
  check('priorité : marquer une vidéo masquée la remet dans le feed',
    restored.items.some((v) => v.id === ids[2] && !v.hidden), restored.items.map((v) => v.id));
  check('priorité : le compteur de masquées suit',
    (await db.getFeedCounts([1])).hidden === hiddenBefore - 1);

  // And conversely: hiding removes the priority. Without this, the video stayed
  // marked in the bin and reappeared in the priorities view.
  await db.setStarred([ids[0]], true);
  await db.setHidden([ids[0]], true);
  check('priorité : masquer retire des priorités',
    !(await db.getFeedPage({ limit: 50, onlyStarred: true, includeHidden: true }))
      .items.some((v) => v.id === ids[0]));
  await db.setHidden([ids[0]], false);
  check('priorité : la remise dans le feed ne rend pas l’étoile',
    !(await db.getFeedPage({ limit: 50, onlyStarred: true })).items.some((v) => v.id === ids[0]));

  await db.setStarred(ids, false);
  const none = await db.getFeedPage({ limit: 50, onlyStarred: true });
  check('priorité : démarquable', none.items.length === 0, none.items.length);

  // -- feed pulse, shown in the popup
  //
  // It only looks at the last thirty real days: the fixtures dated from `BASE_TS`
  // are out of its reach, it needs its own videos, laid down now.
  await db.upsertVideos([
    { id: 'pouls00001', channelId: channelId(1), title: 'Hier', publishedAt: Date.now() - DAY, thumbUrl: 'https://e/p1' },
    { id: 'pouls00002', channelId: channelId(1), title: 'Hier aussi', publishedAt: Date.now() - DAY - HOUR, thumbUrl: 'https://e/p2' },
    { id: 'pouls00003', channelId: channelId(2), title: 'Avant-hier', publishedAt: Date.now() - 2 * DAY, thumbUrl: 'https://e/p3' },
  ]);

  const pulse = await db.getFeedPulse(30);
  check('pouls : les publications sont réparties par jour',
    Object.values(pulse.perDay).reduce((a, b) => a + b, 0) >= 3, pulse.perDay);
  check('pouls : la chaîne la plus active arrive en tête',
    pulse.topMonth[0]?.channelId === channelId(1) && pulse.topMonth[0]?.count === 2, pulse.topMonth);
  check('pouls : le classement est décroissant',
    pulse.topMonth.every((e, i) => i === 0 || pulse.topMonth[i - 1].count >= e.count), pulse.topMonth);
  check('pouls : au plus cinq chaînes classées', pulse.topMonth.length <= 5, pulse.topMonth.length);

  // The pulse says what the channels have published, not what is left to watch:
  // hiding a video does not make it disappear from the histogram. Without this,
  // the curve hollowed out as one tidied up, and two accounts subscribed to the
  // same channels did not read the same thing in it.
  await db.setHidden(['pouls00003'], true);
  const masque = await db.getFeedPulse(30);
  check('pouls : les masquées comptent quand même',
    masque.topMonth.some((e) => e.channelId === channelId(2)), masque.topMonth);
  await db.setHidden(['pouls00003'], false);

  // The count of hidden ones, used by the statistics row.
  const before = await db.getFeedCounts([1]);
  await db.setHidden([ids[0], ids[1]], true);
  const after = await db.getFeedCounts([1]);
  check('compteurs : masquer décrémente le total et incrémente les masquées',
    after.total === before.total - 2 && after.hidden === before.hidden + 2,
    { avant: { t: before.total, m: before.hidden }, apres: { t: after.total, m: after.hidden } });

  // includeHidden mixes the two; onlyHidden is the "bin" view.
  const withHidden = await db.getFeedPage({ limit: 200, includeHidden: true });
  check('includeHidden : masquées et visibles mélangées',
    ids.slice(0, 2).every((id) => withHidden.items.some((v) => v.id === id && v.hidden === 1))
    && withHidden.items.some((v) => !v.hidden));

  const onlyHidden = await db.getFeedPage({ limit: 200, onlyHidden: true });
  check('onlyHidden : que des vidéos masquées, aucune visible',
    onlyHidden.items.length > 0 && onlyHidden.items.every((v) => v.hidden === 1),
    onlyHidden.items.length);
  check('onlyHidden : le compte correspond au compteur de masquées',
    onlyHidden.items.length === after.hidden, { listees: onlyHidden.items.length, comptees: after.hidden });
  check('onlyHidden : toujours antichronologique',
    onlyHidden.items.every((v, i) => i === 0 || onlyHidden.items[i - 1].publishedAt >= v.publishedAt));

  await db.setHidden([ids[0], ids[1]], false);
  const emptied = await db.getFeedPage({ limit: 200, onlyHidden: true });
  check('onlyHidden : se vide quand tout est restauré',
    !emptied.items.some((v) => ids.includes(v.id)), emptied.items.length);
}

/**
 * Tightness of the native feed harvest.
 *
 * A regression actually lived through: a Short appeared in the feed. It was in
 * none of the channel's RSS feeds — it came from YouTube's native feed, which
 * contains them and whose DOM does not allow setting them aside reliably. The
 * harvest must therefore enrich without ever creating.
 */
async function testNativeHarvestIsolation(check) {
  const base = BASE_TS + 150 * DAY;
  const connue = 'known000001';
  await db.upsertVideos([{
    id: connue, channelId: channelId(1), channelTitle: 'Chaîne 1',
    title: 'Déjà connue par les flux', publishedAt: base, thumbUrl: 'https://e/k',
  }]);

  // A perfectly formed Short, with a channelId: it would have been inserted before.
  const res = await db.upsertVideos([
    { id: 'short000001', channelId: channelId(1), channelTitle: 'Chaîne 1',
      title: 'Un Short venu du feed natif', publishedAt: base + HOUR,
      thumbUrl: 'https://e/s', seenNativeAt: Date.now(), source: 'native' },
    { id: connue, durationSec: 754, seenNativeAt: Date.now(), source: 'native' },
  ], { allowInsert: false });

  check('moisson native : n’insère rien', res.inserted === 0 && res.skipped === 1, res);
  check('moisson native : enrichit quand même l’existant', res.updated === 1, res.updated);

  const page = await db.getFeedPage({ limit: 200, includeHidden: true });
  check('moisson native : le Short n’entre pas dans le feed',
    !page.items.some((v) => v.id === 'short000001'));
  check('moisson native : la durée est bien arrivée sur la vidéo connue',
    page.items.find((v) => v.id === connue)?.durationSec === 754);

  // -- purging the native insertions already made
  await db.upsertVideos([
    { id: 'legacy00001', channelId: channelId(1), channelTitle: 'Chaîne 1',
      title: 'Short inséré avant le correctif', publishedAt: base, thumbUrl: 'https://e/l',
      source: 'native' },
    { id: 'legacy00002', channelId: channelId(1), channelTitle: 'Chaîne 1',
      title: 'Native mais mise en priorité', publishedAt: base, thumbUrl: 'https://e/l2',
      source: 'native' },
  ]);
  await db.setStarred(['legacy00002'], true);

  const removed = await db.purgeNativeInserted();
  const after = await db.getFeedPage({ limit: 300, includeHidden: true });

  check('purge : retire les vidéos créées par la moisson', removed >= 1
    && !after.items.some((v) => v.id === 'legacy00001'), removed);
  check('purge : épargne celles que l’utilisateur a marquées',
    after.items.some((v) => v.id === 'legacy00002'));
  check('purge : ne touche pas aux vidéos issues des flux',
    after.items.some((v) => v.id === connue));
}

// ---------------------------------------------------------------------------

/**
 * The internal API's parsers.
 *
 * They are now shared between the content script and the service worker: a
 * regression here would break both at once, and silently, since everything
 * returns empty lists rather than errors.
 *
 * The templates reproduced below come from real responses, cut down to what the
 * functions look at.
 */
/**
 * Partitioning by account.
 *
 * The sensitive point is not whether two strings are equal, it is knowing when
 * one is **not** allowed to conclude: a failed read or a page seen while signed
 * out must not pass for a foreign account, otherwise the extension stops writing
 * for people whose page simply answered badly.
 */
function testCompte(check) {
  const cle = 'AbCd||EfGh';

  check('compte : la clé du compte connecté est reprise telle quelle',
    accountKey({ loggedIn: true, datasyncId: cle }) === cle);
  check('compte : déconnecté, il n’y a pas de clé',
    accountKey({ loggedIn: false, datasyncId: 'Ved2ffbf6||' }) === null);
  check('compte : une valeur sans séparateur n’est pas une clé',
    accountKey({ loggedIn: true, datasyncId: 'Ved2ffbf6' }) === null);
  check('compte : rien à lire donne rien',
    accountKey(undefined) === null && accountKey({ loggedIn: true }) === null);

  check('compte : deux chaînes de marque du même compte sont deux comptes',
    !sameAccount('chaineA||moi', 'chaineB||moi'));
  check('compte : la même clé se reconnaît',
    sameAccount(cle, cle));
  check('compte : une base sans propriétaire accepte tout',
    sameAccount(null, cle));
  check('compte : une observation sans clé n’est pas un refus',
    sameAccount(cle, null));
}

function testInnertubeParse(check) {
  // The recent template: no named field for the duration any more, it is in a
  // badge laid on the thumbnail.
  const lockup = {
    contents: [{
      lockupViewModel: {
        contentId: 'ltLAZsJELng',
        contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
        metadata: { lockupMetadataViewModel: { title: { content: 'Fusion nucléaire' } } },
        contentImage: {
          thumbnailViewModel: {
            overlays: [{
              thumbnailBottomOverlayViewModel: {
                badges: [{ thumbnailBadgeViewModel: { text: '30:27' } }],
              },
            }],
          },
        },
      },
    }],
  };
  const vus = itp.extractPlaylistVideos(lockup);
  check('innertube : lockup rendu', vus.length === 1 && vus[0].id === 'ltLAZsJELng');
  check('innertube : titre du lockup', vus[0]?.title === 'Fusion nucléaire');
  check('innertube : durée lue dans le badge', vus[0]?.durationSec === 1827, vus[0]?.durationSec);

  const membre = {
    lockupViewModel: {
      contentId: 'memberonly1', contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
      metadata: { lockupMetadataViewModel: {
        title: { content: 'Avant première' },
        metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{
          text: { content: 'Members only' },
        }] }] } },
      } },
    },
  };
  check('innertube : le badge explicite membres est conservé par le parseur',
    itp.extractPlaylistVideos(membre)[0]?.membersOnly === true);
  check('innertube : le mot member dans un titre ne classe jamais la vidéo',
    itp.isMembersOnlyRenderer({ title: { simpleText: 'A member of the team' } }) === false);

  // The old template is still served by some responses.
  const ancien = {
    items: [{
      playlistVideoRenderer: {
        videoId: 'aaaaaaaaaaa',
        title: { runs: [{ text: 'Deux ' }, { text: 'morceaux' }] },
        lengthText: { simpleText: '1:02:03' },
      },
    }],
  };
  const vieux = itp.extractPlaylistVideos(ancien);
  check('innertube : playlistVideoRenderer rendu', vieux.length === 1);
  check('innertube : titre recollé depuis les runs', vieux[0]?.title === 'Deux morceaux');
  check('innertube : durée à trois champs', vieux[0]?.durationSec === 3723, vieux[0]?.durationSec);

  const abondante = { items: ['00000000001', '00000000002', '00000000003'].map((videoId) => ({
    playlistVideoRenderer: { videoId, title: { simpleText: videoId } },
  })) };
  const limitee = itp.extractPlaylistVideos(abondante, [], new Set(), 2);
  check('innertube : l’analyse s’arrête au nombre de vidéos demandé',
    limitee.length === 2 && limitee[1]?.id === '00000000002', limitee.map((v) => v.id));

  // An item that is not a video must produce nothing: playlists contain them
  // (suggested channels, shelves), and counting them would manufacture ids that
  // lead nowhere.
  const autre = { x: { lockupViewModel: { contentId: 'UCzzz', contentType: 'LOCKUP_CONTENT_TYPE_CHANNEL' } } };
  check('innertube : un lockup non vidéo est ignoré', itp.extractPlaylistVideos(autre).length === 0);

  // Live and scheduled are read from the badge's style, never from its text,
  // which is translated.
  const direct = {
    a: {
      lockupViewModel: {
        contentId: 'bbbbbbbbbbb', contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
        badge: { style: 'THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE' },
      },
    },
  };
  const prevu = {
    a: {
      lockupViewModel: {
        contentId: 'ccccccccccc', contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
        badge: { badgeStyle: 'BADGE_STYLE_TYPE_UPCOMING' },
        endpoint: { watchEndpoint: { startTime: 1_700_000_000 } },
      },
    },
  };
  check('innertube : direct détecté', itp.extractPlaylistVideos(direct)[0]?.isLive === true);
  const p = itp.extractPlaylistVideos(prevu)[0];
  check('innertube : programmation détectée', p?.isUpcoming === true && p?.isLive === false);
  check('innertube : heure annoncée en millisecondes', p?.scheduledAt === 1_700_000_000_000, p?.scheduledAt);

  // One response must not give back the same video twice: the walk is recursive
  // and YouTube's responses contain cycles.
  const partage = { lockupViewModel: lockup.contents[0].lockupViewModel };
  partage.self = partage;
  check('innertube : pas de doublon malgré un cycle',
        itp.extractPlaylistVideos(partage).length === 1);

  // Continuation token, wherever it is.
  const suite = {
    onResponseReceivedActions: [{
      appendContinuationItemsAction: {
        continuationItems: [{
          continuationItemRenderer: {
            continuationEndpoint: { continuationCommand: { token: 'JETON42' } },
          },
        }],
      },
    }],
  };
  check('innertube : jeton de continuation', itp.extractContinuation(suite) === 'JETON42');
  check('innertube : pas de jeton, pas de valeur', itp.extractContinuation({ a: { b: 1 } }) === null);

  const sourceAbonnements = {
    contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: {
      richGridRenderer: { contents: [
      { richItemRenderer: { content: { videoRenderer: {
        videoId: 'source00001', title: { simpleText: 'Vidéo source' },
        ownerText: { runs: [{ text: 'Chaîne source', navigationEndpoint: {
          browseEndpoint: { browseId: 'UCcccccccccccccccccccccc' },
        } }] },
        publishedTimeText: { simpleText: '3 days ago' },
      } } } },
      { richSectionRenderer: { content: { shortsLockupViewModel: { onTap: { innertubeCommand: {
        reelWatchEndpoint: { videoId: 'sourceshort1' },
      } } } } } },
    ] },
    } } }] } },
    // Entity updates contain off-screen models and used to manufacture hundreds
    // of apparent omissions, including videos several months old.
    frameworkUpdates: { entityBatchUpdate: { mutations: [{ payload: {
      lockupViewModel: {
        contentId: 'sourceold01', contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
        metadata: { lockupMetadataViewModel: { title: { content: 'Ancienne hors grille' } } },
      },
    } }] } },
  };
  const sourceVideos = itp.extractSubscriptionFeedVideos(sourceAbonnements, 1_800_000_000_000);
  check('audit inverse : la source Abonnements fournit les vidéos ordinaires',
    sourceVideos.length === 1 && sourceVideos[0].id === 'source00001', sourceVideos);
  check('audit inverse : la profondeur se lit depuis la date relative anglaise',
    sourceVideos[0]?.publishedAt === 1_800_000_000_000 - 3 * DAY, sourceVideos[0]);
  check('audit inverse : les gabarits Shorts de la source sont exclus explicitement',
    !sourceVideos.some((video) => video.id === 'sourceshort1'), sourceVideos);
  check('audit inverse : les modèles internes hors grille sont ignorés',
    !sourceVideos.some((video) => video.id === 'sourceold01'), sourceVideos);

  // The avatar must come from the channel metadata. Authenticated responses also
  // carry the current account's picture before it in the JSON envelope.
  const avatar = {
    responseContext: { account: { avatar: {
      url: 'https://yt3.ggpht.com/mon-compte=s48-c-k-c0x00ffffff-no-rj',
    } } },
    metadata: { channelMetadataRenderer: { avatar: { thumbnails: [
      { url: 'https://yt3.ggpht.com/abc=s48-c-k-c0x00ffffff-no-rj' },
    ] } } },
  };
  check('innertube : avatar agrandi',
        itp.extractOwnerAvatar(avatar) === 'https://yt3.ggpht.com/abc=s176-c-k-c0x00ffffff-no-rj',
        itp.extractOwnerAvatar(avatar));
  check('innertube : la photo du compte connecté n’est jamais prise pour celle de la chaîne',
        !itp.extractOwnerAvatar(avatar).includes('mon-compte'), itp.extractOwnerAvatar(avatar));
  check('innertube : une image qui n\'est pas un avatar est ignorée',
        itp.extractOwnerAvatar({ u: 'https://i.ytimg.com/vi/x/hq.jpg' }) === null);

  const mergedTab = itp.mergeVideoTabEntries(
    [{ id: 'mergedtab01', title: 'Vidéo', publishedAt: 1_800_000_000_000 }],
    [{ id: 'mergedtab01', title: 'Vidéo', durationSec: 754, isLive: false }],
  );
  check('onglet Vidéos : date et durée de la même carte restent réunies',
    mergedTab.length === 1 && mergedTab[0].publishedAt === 1_800_000_000_000
      && mergedTab[0].durationSec === 754 && mergedTab[0].sourceKind === 'videos-tab',
    mergedTab);
  const tabFacts = itp.factsFromVideosTab(mergedTab[0]);
  check('onglet Vidéos : une carte complète est insérable sans seconde requête player',
    tabFacts?.id === 'mergedtab01' && tabFacts.durationSec === 754
      && tabFacts.publishedAt === 1_800_000_000_000 && tabFacts.isShort === false,
    tabFacts);

  // Malformed durations: no duration beats an invented one.
  check('innertube : durée vide', itp.parseDuration('') === null);
  check('innertube : durée non numérique', itp.parseDuration('en direct') === null);
  check('innertube : durée simple', itp.parseDuration('9:05') === 545);

  // The only reliable discriminator of a Short. The three cases measured on one
  // channel in August 2026: an 18 second Short in 16:9, and two ordinary videos
  // of 12 and 25 seconds. The duration would have classified them together.
  const fiche = (url) => ({ microformat: { playerMicroformatRenderer: { canonicalUrl: url } } });
  check('Shorts : l\u2019URL canonique /shorts/ tranche',
        itp.isShort(fiche('https://www.youtube.com/shorts/JAdcMZbvMcs')) === true);
  check('Shorts : une vidéo courte ordinaire n\u2019en est pas un',
        itp.isShort(fiche('https://www.youtube.com/watch?v=5OFow3ISW5A')) === false);
  check('Shorts : sans microformat, aucune conclusion',
        itp.isShort({}) === null && itp.isShort(null) === null);
  check('Shorts : le titre ne décide de rien',
        itp.isShort({
          videoDetails: { title: 'In vino veritas #shorts' },
          microformat: { playerMicroformatRenderer: { canonicalUrl: 'https://www.youtube.com/watch?v=5OFow3ISW5A' } },
        }) === false);
  const exactFacts = itp.extractPlayerFacts({
    videoDetails: {
      videoId: '5OFow3ISW5A', title: 'Courte mais normale', lengthSeconds: '12', viewCount: '42',
    },
    microformat: { playerMicroformatRenderer: {
      canonicalUrl: 'https://www.youtube.com/watch?v=5OFow3ISW5A',
      publishDate: '2026-09-18T12:34:56Z',
    } },
  }, '5OFow3ISW5A');
  check('innertube : les faits player partagés gardent date, durée et verdict YouTube',
    exactFacts?.publishedAt === Date.parse('2026-09-18T12:34:56Z')
      && exactFacts.durationSec === 12 && exactFacts.views === 42 && exactFacts.isShort === false,
    exactFacts);
  check('innertube : une réponse player pour un autre identifiant est refusée',
    itp.extractPlayerFacts({ videoDetails: { videoId: 'other000001' } }, '5OFow3ISW5A') === null);
  const memberFacts = itp.extractPlayerFacts({
    videoDetails: { videoId: 'memberonly1' },
    playabilityStatus: { status: 'UNPLAYABLE', reason: 'This video is available to members only' },
  }, 'memberonly1');
  check('innertube : le refus player réservé aux membres est explicite',
    memberFacts?.membersOnly === true, memberFacts);

  // ---------------------------------------------------------------- history page

  // The shape measured on 28 August 2026: two templates inside one and the same
  // section, and the date carried by the section rather than by the entries.
  const bloc = (label, items) => ({
    itemSectionRenderer: {
      header: { itemSectionHeaderRenderer: { title: { runs: [{ text: label }] } } },
      contents: items,
    },
  });
  const carte = (id, titre, chaine, uc) => ({
    lockupViewModel: {
      contentId: id,
      contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
      metadata: {
        lockupMetadataViewModel: {
          title: { content: titre },
          image: {
            decoratedAvatarViewModel: {
              rendererContext: {
                commandContext: {
                  onTap: { innertubeCommand: { browseEndpoint: { browseId: uc } } },
                },
              },
            },
          },
          metadata: {
            contentMetadataViewModel: {
              metadataRows: [{ metadataParts: [{ text: { content: chaine } }, { text: { content: '32 vues' } }] }],
            },
          },
        },
      },
    },
  });

  const reponse = {
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [
          bloc('Today', [
            carte('vid00000001', 'Une', 'Decrypt', 'UCaaaaaaaaaaaaaaaaaaaaaa'),
            { videoRenderer: { videoId: 'vid00000002', title: { simpleText: 'Deux' },
                               ownerText: { runs: [{ text: 'Ancienne' }] },
                               longBylineText: { runs: [{ navigationEndpoint: { browseEndpoint: { browseId: 'UCbbbbbbbbbbbbbbbbbbbbbb' } } }] } } },
          ]),
          bloc('Aug 21', [carte('vid00000003', 'Trois', 'Decrypt', 'UCaaaaaaaaaaaaaaaaaaaaaa')]),
        ] } } } }],
      },
    },
  };

  const sections = itp.extractHistorySections(reponse);
  check('historique : les sections sortent dans l\u2019ordre de la page',
        sections.length === 2 && sections[0].label === 'Today' && sections[1].label === 'Aug 21', sections);
  check('historique : les deux gabarits cohabitent dans une même section',
        sections[0].entries.length === 2
        && sections[0].entries[0].videoId === 'vid00000001'
        && sections[0].entries[1].videoId === 'vid00000002', sections[0]);
  check('historique : la chaîne est retrouvée sous les deux gabarits',
        sections[0].entries[0].channelId === 'UCaaaaaaaaaaaaaaaaaaaaaa'
        && sections[0].entries[1].channelId === 'UCbbbbbbbbbbbbbbbbbbbbbb', sections[0].entries);
  check('historique : le titre de la chaîne est la première part, pas le nombre de vues',
        sections[0].entries[0].channelTitle === 'Decrypt', sections[0].entries[0]);

  // A continuation arrives under another key entirely, and must read the same.
  const page2 = { onResponseReceivedActions: [{ appendContinuationItemsAction: {
    continuationItems: [bloc('Jan 26, 2025', [carte('vid00000004', 'Quatre', 'Decrypt', 'UCaaaaaaaaaaaaaaaaaaaaaa')])],
  } }] };
  check('historique : une continuation se lit comme une première page',
        itp.extractHistorySections(page2).length === 1);

  // The headings. The reference is a Thursday, so that the weekday branch has
  // something to resolve against.
  const jeudi = new Date(2026, 7, 27, 9, 30).getTime();
  const jour = (t) => (t === null ? null : new Date(t).toISOString().slice(0, 10));
  const midi = (t) => new Date(t).getHours() === 12;

  check('historique : « Today » est le jour de référence',
        jour(itp.parseHistoryDay('Today', jeudi)) === jour(jeudi));
  check('historique : « Yesterday » est la veille',
        jour(itp.parseHistoryDay('Yesterday', jeudi)) === '2026-08-26');
  check('historique : un jour de la semaine remonte au plus récent passé',
        jour(itp.parseHistoryDay('Monday', jeudi)) === '2026-08-24');
  check('historique : jamais le jour de référence lui même',
        jour(itp.parseHistoryDay('Thursday', jeudi)) === '2026-08-20');
  check('historique : une date sans année est de l\u2019année en cours',
        jour(itp.parseHistoryDay('Aug 21', jeudi)) === '2026-08-21');
  check('historique : une date sans année qui serait à venir est de l\u2019an dernier',
        jour(itp.parseHistoryDay('Dec 30', jeudi)) === '2025-12-30');
  check('historique : une date avec année est prise telle quelle',
        jour(itp.parseHistoryDay('Jan 26, 2025', jeudi)) === '2025-01-26');
  check('historique : l\u2019heure retenue est midi, pas minuit',
        midi(itp.parseHistoryDay('Aug 21', jeudi)));
  check('historique : un intitulé illisible ne donne pas de date',
        itp.parseHistoryDay('Playlists', jeudi) === null
        && itp.parseHistoryDay('', jeudi) === null);

  testPistesSonores(check);
}

/**
 * The order the sound tracks are offered in.
 *
 * Taken from the answer for `HR97H1yqgVc` on 7 October 2026, the video reported
 * as having no sound: two original mp4 tracks, each present twice, plain and
 * DRC. Three of those four refused their bytes at that moment and the fourth,
 * itag 140 DRC, served; twenty minutes later the pair had swapped. So nothing
 * here asserts which one works. What is locked down is that none of them is
 * thrown away before the probe has had a chance to try it, because discarding
 * the DRC form is exactly what left three videos out of thirteen silent.
 */
function testPistesSonores(check) {
  // `xtags` as YouTube sends it: base64url of a small protobuf. Built rather
  // than pasted, so the test says what it holds.
  const xtags = (contenu, drc) => {
    const octets = `\x00\x05acont\x00${contenu}` + (drc ? '\x00\x03drc\x00\x011' : '');
    return btoa(octets).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const piste = (nom, codec, drc, contenu, bitrate) => ({
    url: `https://example/${nom}`,
    mimeType: `audio/mp4; codecs="${codec}"`,
    bitrate,
    isDrc: drc,
    audioTrack: { id: 'fr-FR.4', audioIsDefault: !drc },
    xtags: xtags(contenu, drc),
    initRange: { start: 0, end: 722 },
    indexRange: { start: 723, end: 2422 },
    contentLength: '22322581',
  });

  const formats = [
    piste('139', 'mp4a.40.5', false, 'original', 51167),
    piste('139drc', 'mp4a.40.5', true, 'original', 51168),
    piste('140', 'mp4a.40.2', false, 'original', 131644),
    piste('140drc', 'mp4a.40.2', true, 'original', 131639),
    piste('doublage', 'mp4a.40.2', false, 'dubbed-auto', 131614),
  ];
  const ordre = itp.audioCandidates(formats).map((p) => p.url.split('/').pop());

  check('aperçu : la variante compressée est redevenue une solution de repli',
        ordre.length === 4, ordre);
  check('aperçu : AAC LC devant, et la piste franche devant sa jumelle compressée',
        ordre.join(' ') === '140 140drc 139 139drc', ordre.join(' '));
  check('aperçu : le doublage reste écarté, même en dernier recours',
        !ordre.includes('doublage'), ordre);
  check('aperçu : la première proposée est celle que retient pickAudio',
        itp.pickAudio(formats)?.url === itp.audioCandidates(formats)[0]?.url);

  // A single track video carries no `audioTrack` at all, and is original by
  // construction: asking it for its language would exclude it.
  const seule = [{ url: 'https://example/seule', mimeType: 'audio/mp4; codecs="mp4a.40.2"',
    bitrate: 131644, initRange: { start: 0, end: 722 }, indexRange: { start: 723, end: 2422 } }];
  check('aperçu : une vidéo à piste unique est originale par construction',
        itp.audioCandidates(seule).length === 1);

  // Nothing readable: no sound, rather than a track taken at random.
  check('aperçu : une réponse sans son ne propose rien',
        itp.audioCandidates([]).length === 0 && itp.audioCandidates(null).length === 0
        && itp.pickAudio(undefined) === null);

  // The byte ranges, which decide whether a track is usable at all.
  check('aperçu : une plage d\u2019octets illisible n\u2019en est pas une',
        itp.range({ start: 0, end: 722 })?.end === 722
        && itp.range({ start: 10, end: 10 }) === null
        && itp.range(undefined) === null);
}


/**
 * The precedence between the three sources of the history.
 *
 * Written after the measurement of 28 August 2026: on one real account the
 * Takeout export held 12 764 viewings from May 2024, YouTube's own history page
 * 44 349 from March 2020. Completing with the second is worth it; letting it
 * overwrite the first, or add itself on top of it, would turn one viewing into
 * two on every day both know about.
 */
async function testHistoriqueRecupere(check) {
  const midi = (iso) => new Date(`${iso}T12:00:00`).getTime();
  const ligne = (id, iso) => ({
    videoId: id, watchedAt: midi(iso), title: `T ${id}`,
    channelId: 'UCrecuperee000000000000', channelTitle: 'Chaîne',
  });

  const a = await db.putScrapedHistory([ligne('recup000001', '2021-04-02')]);
  check('récupéré : une ligne inédite entre', a.inserted === 1 && a.covered === 0, a);

  const b = await db.putScrapedHistory([ligne('recup000001', '2021-04-02')]);
  check('récupéré : la même ligne deux fois n\u2019entre qu\u2019une fois',
        b.inserted === 0 && b.covered === 1, b);

  // Same video, another day: that is a second viewing, not a duplicate.
  const c = await db.putScrapedHistory([ligne('recup000001', '2021-04-03')]);
  check('récupéré : un autre jour est un autre visionnage', c.inserted === 1, c);

  // A precise row already covering that day closes it.
  await db.putHistory([{
    videoId: 'recup000002', watchedAt: new Date('2021-05-10T21:14:00').getTime(),
    title: 'Précise', channelId: 'UCrecuperee000000000000', channelTitle: 'Chaîne',
  }]);
  const d = await db.putScrapedHistory([ligne('recup000002', '2021-05-10')]);
  check('récupéré : un jour déjà couvert par Takeout est laissé tel quel',
        d.inserted === 0 && d.covered === 1, d);

  // The one that matters most, because it is the one that would destroy work
  // nothing can produce again: a session the extension measured itself. The
  // collection reads every row of that video, all sources together, before
  // writing anything, and a day already covered is left untouched — the measured
  // seconds stay, and no second row appears next to them.
  await db.putWatchSession({
    videoId: 'recup000004', watchedAt: new Date('2021-07-04T19:30:00').getTime(),
    watchedSec: 742, title: 'Mesurée',
    channelId: 'UCrecuperee000000000000', channelTitle: 'Chaîne',
  });
  const e = await db.putScrapedHistory([ligne('recup000004', '2021-07-04')]);
  const mesuree = (await db.getAllHistory()).filter((x) => x.videoId === 'recup000004');
  check('récupéré : une séance mesurée n’est ni écrasée ni doublée',
        e.inserted === 0 && mesuree.length === 1
        && mesuree[0].source === 'live' && mesuree[0].watchedSec === 742,
        [e, mesuree]);

  // And the other way round: a Takeout export arriving later takes the place of
  // the récupérée row instead of doubling that day.
  await db.putScrapedHistory([ligne('recup000003', '2021-06-01')]);
  await db.putHistory([{
    videoId: 'recup000003', watchedAt: new Date('2021-06-01T08:02:00').getTime(),
    title: 'Précise', channelId: 'UCrecuperee000000000000', channelTitle: 'Chaîne',
  }]);
  const pour = (await db.getAllHistory()).filter((e) => e.videoId === 'recup000003');
  check('récupéré : un export Takeout ultérieur remplace la ligne récupérée',
        pour.length === 1 && pour[0].source === 'takeout', pour);

  // The hourly curve must not gain a spike at noon nobody ever watched.
  const heures = hist.computeStats([
    { videoId: 'heure00001', watchedAt: midi('2021-04-02'), source: 'yt',
      title: 'A', channelId: 'UCheure0000000000000000', channelTitle: 'C' },
    { videoId: 'heure00002', watchedAt: new Date('2021-04-02T21:00:00').getTime(), source: 'takeout',
      title: 'B', channelId: 'UCheure0000000000000000', channelTitle: 'C' },
  ]);
  check('récupéré : une ligne sans heure reste hors de la courbe par heure',
        heures.perHour[12] === 0 && heures.perHour[21] === 1, heures.perHour);
  check('récupéré : la portée de la courbe est comptée',
        heures.withClock === 1 && heures.total === 2, heures.withClock);
}


/**
 * The journal: one day read row by row.
 *
 * It is the debugging view, so it must show a row exactly as it is stored. Two
 * things it must never do: hide a difference between sources behind a total, and
 * count a video's length on top of a measurement of that same video.
 */
/**
 * The four figures that say how one watches rather than how much: the delay
 * before opening, the sittings, the rewatches and the drop off point.
 */
function testManiereDeRegarder(check) {
  const at = (iso) => new Date(iso).getTime();
  const ligne = (id, iso, extra = {}) => ({
    key: `${id}|${at(iso)}`, videoId: id, watchedAt: at(iso), title: `T ${id}`,
    channelId: 'UCman00000000000000000', channelTitle: 'Chaîne', source: 'live', ...extra,
  });

  // --- the delay before opening -------------------------------------------
  const published = new Map([
    ['man0000001', at('2026-08-20T08:00:00')],   // opened three hours later
    ['man0000002', at('2026-08-17T08:00:00')],   // opened three days later
    ['man0000003', at('2026-01-01T08:00:00')],   // opened months later
  ]);
  const vus = [
    ligne('man0000001', '2026-08-20T11:00:00'),
    ligne('man0000002', '2026-08-20T11:00:00'),
    ligne('man0000003', '2026-08-20T11:00:00'),
    // No publication date: counted in the total, never in the distribution.
    ligne('man0000009', '2026-08-20T11:00:00'),
  ];
  const d = hist.computeWatchDelays(vus, published);
  check('délai : trois vidéos datées sur quatre', d.known === 3 && d.total === 4);
  const par = new Map(d.buckets.map((b) => [b.id, b.n]));
  check('délai : une le jour même, une dans la semaine, une dans l\'année',
    par.get('d1') === 1 && par.get('d7') === 1 && par.get('d365') === 1);

  // Below a week the slices are counted in hours: "within the month" would hold
  // everything such a range can hold, and three bars out of four would then
  // answer the same question.
  const courte = hist.computeWatchDelays(vus, published, {
    from: at('2026-08-14T00:00:00'), to: at('2026-08-21T00:00:00'),
  });
  check('délai : sous la semaine, les tranches se comptent en heures',
    courte.buckets.map((b) => b.id).join(',') === 'h1,h6,h24,later');
  check('délai : trois heures après la sortie tombe dans les 6 h',
    courte.buckets[1].n === 1 && courte.buckets[3].n === 2);

  // A viewing dated before its publication is a broken row, not a fast viewer.
  const avant = hist.computeWatchDelays(
    [ligne('man0000001', '2026-08-20T07:00:00')], published);
  check('délai : un visionnage antérieur à la publication est écarté', avant.known === 0);

  // --- the sittings --------------------------------------------------------
  const seance = hist.computeSessions([
    ligne('man0000001', '2026-08-20T20:00:00', { watchedSec: 600 }),
    ligne('man0000002', '2026-08-20T20:20:00', { watchedSec: 600 }),
    // More than half an hour after the end of the previous one: a new sitting.
    ligne('man0000003', '2026-08-20T22:00:00', { watchedSec: 600 }),
  ]);
  check('séances : deux sittings séparés par plus d\'une demi heure', seance.count === 2);
  check('séances : la plus longue tient les deux premières vidéos',
    seance.longest.videos === 2);

  // A row read off YouTube's history page sits at local noon: counting it would
  // invent a midday sitting nobody had.
  const sansHeure = hist.computeSessions([
    ligne('man0000001', '2026-08-20T20:00:00', { watchedSec: 600 }),
    ligne('man0000004', '2026-08-20T12:00:00', { source: 'yt' }),
  ]);
  check('séances : les lignes sans heure sont exclues mais comptées dans la portée',
    sansHeure.count === 1 && sansHeure.rows === 1 && sansHeure.total === 2);

  // --- the rewatches -------------------------------------------------------
  const revu = hist.computeRewatches([
    ligne('man0000001', '2026-08-01T10:00:00'),
    ligne('man0000001', '2026-08-20T10:00:00'),
    ligne('man0000001', '2026-08-25T10:00:00'),
    ligne('man0000002', '2026-08-20T10:00:00'),
  ]);
  check('revisionnages : seule la vidéo ouverte plusieurs fois remonte',
    revu.total === 1 && revu.videos[0].videoId === 'man0000001' && revu.videos[0].opens === 3);
  check('revisionnages : la première et la dernière fois encadrent les trois',
    revu.videos[0].first === at('2026-08-01T10:00:00')
    && revu.videos[0].last === at('2026-08-25T10:00:00'));
  // The denominator of the headline figure: two distinct videos for four rows.
  check('revisionnages : les vidéos distinctes servent de dénominateur',
    revu.distinct === 2);

  // --- the drop off point --------------------------------------------------
  const durees = new Map([['man0000001', 1000], ['man0000002', 1000]]);
  const decroche = hist.computeDropoff([
    ligne('man0000001', '2026-08-20T10:00:00', { watchedSec: 300 }),
    // Watched to the end: not an abandonment.
    ligne('man0000002', '2026-08-20T11:00:00', { watchedSec: 980 }),
    // No exact duration: a channel mean would turn the percentage into an
    // invention, so the row is left out.
    ligne('man0000003', '2026-08-20T12:00:00', { watchedSec: 300 }),
  ], durees);
  check('décrochage : une seule vidéo abandonnée retenue', decroche.n === 1);
  check('décrochage : la part médiane est celle de la vidéo retenue',
    Math.abs(decroche.medianShare - 0.3) < 1e-9 && decroche.medianSec === 300);

  // --- the publication rhythm ---------------------------------------------
  const now = at('2026-08-20T12:00:00');
  const uploads = [
    { channelId: 'UCman00000000000000000', publishedAt: now - 5 * DAY },
    { channelId: 'UCman00000000000000000', publishedAt: now - 20 * DAY },
    // Older than the thirty day window: this is what proves the index covers it.
    { channelId: 'UCman00000000000000000', publishedAt: now - 40 * DAY },
    { channelId: 'UCautre0000000000000000', publishedAt: now - 200 * DAY },
  ];
  const rythme = hist.computeUploadRhythm(uploads,
    { channelId: 'UCman00000000000000000', now });
  check('rythme : la fenêtre de 30 jours compte les deux publications',
    rythme.windows[0].days === 30 && rythme.windows[0].count === 2);
  // The index starts at the installation: a window reaching further back than it
  // does would count our own silence as the channel's.
  check('rythme : une fenêtre plus ancienne que l\'index n\'est pas couverte',
    rythme.windows[2].covered === false && rythme.windows[2].count === 0);
}

async function testJournalDuJour(check) {
  const at = (iso) => new Date(iso).getTime();
  const day = { from: at('2026-08-20T00:00:00'), to: at('2026-08-20T23:59:59.999') };
  const durations = new Map([['jour0000001', 600], ['jour0000002', 1200]]);
  const means = new Map([['UCjour00000000000000000', 900]]);

  const ligne = (id, iso, extra = {}) => ({
    key: `${id}|${at(iso)}`, videoId: id, watchedAt: at(iso), title: `T ${id}`,
    channelId: 'UCjour00000000000000000', channelTitle: 'Chaîne', ...extra,
  });

  const all = [
    ligne('jour0000001', '2026-08-20T09:00:00', { source: 'live', watchedSec: 300 }),
    ligne('jour0000002', '2026-08-20T21:30:00', { source: 'takeout' }),
    ligne('jour0000003', '2026-08-20T12:00:00', { source: 'yt' }),
    // Outside the day, on either side: they must set the neighbours and nothing
    // else.
    ligne('jour0000004', '2026-08-18T10:00:00', { source: 'takeout' }),
    ligne('jour0000005', '2026-08-23T10:00:00', { source: 'takeout' }),
  ];

  const j = hist.buildDayJournal(all, { ...day, durations, channelMeans: means });

  check('journal : seules les lignes du jour sont retenues',
    j.entries.length === 3, j.entries.map((e) => e.videoId));
  check('journal : les lignes sortent dans l’ordre où elles sont arrivées',
    j.entries.map((e) => e.videoId).join(',') === 'jour0000001,jour0000003,jour0000002',
    j.entries.map((e) => e.videoId));
  check('journal : la provenance de chaque ligne est dite',
    j.entries.map((e) => e.source).join(',') === 'live,yt,takeout',
    j.entries.map((e) => e.source));
  check('journal : une ligne sans horloge est signalée comme telle',
    j.entries[1].hasClock === false && j.entries[0].hasClock === true,
    j.entries.map((e) => e.hasClock));

  // The progress bar exists only where something was measured, and it is read
  // against a real length when there is one.
  check('journal : la progression vient de la mesure rapportée à la durée',
    Math.abs(j.entries[0].progress - 0.5) < 1e-9, j.entries[0].progress);
  check('journal : sans mesure, pas de progression inventée',
    j.entries[1].progress === null && j.entries[2].progress === null);

  // A length borrowed from the channel's average must never pass for the
  // video's own: that is the difference the interface shows in italics.
  check('journal : une durée empruntée à la moyenne de la chaîne est marquée',
    j.entries[0].exactDuration === true && j.entries[1].exactDuration === false,
    j.entries.map((e) => e.exactDuration));
  check('journal : la moyenne de la chaîne sert de durée par défaut',
    j.entries[1].durationSec === 900, j.entries[1].durationSec);

  // The same arithmetic as the mixed model: 300 measured on the first video,
  // plus the lengths of the two that were never measured, 900 and 1200.
  check('journal : le temps du jour ne compte jamais deux fois la même vidéo',
    j.summary.seconds === 2400, j.summary.seconds);
  check('journal : le jour se résume en visionnages, vidéos et chaînes',
    j.summary.total === 3 && j.summary.videos === 3 && j.summary.channels === 1,
    j.summary);
  check('journal : les ouvertures mesurées sont dénombrées',
    j.summary.measured === 1, j.summary.measured);

  // The figure the page shows: the measurement alone. The mixed total above is
  // right over months and is a guess on one day — four two hour videos merely
  // opened announced eleven hours watched.
  check('journal : le temps mesuré ne compte que ce qui a été mesuré',
    j.summary.measuredSeconds === 300, j.summary.measuredSeconds);

  // 600 + 900 + 1200 of length known, 300 of it measured.
  check('journal : la couverture dit sur combien de vidéos elle porte',
    j.summary.coverage.videos === 3 && j.summary.coverage.unknown === 0, j.summary.coverage);
  check('journal : la couverture cumule les durées connues',
    j.summary.coverage.seconds === 2700, j.summary.coverage.seconds);
  check('journal : et le temps réellement mesuré sur ces vidéos là',
    j.summary.coverage.watched === 300, j.summary.coverage.watched);

  // A measurement can exceed a length that is only the channel's average: the
  // day would otherwise report more watched than there was to watch.
  const debord = hist.buildDayJournal(
    [ligne('jour0000001', '2026-08-20T09:00:00', { source: 'live', watchedSec: 9000 })],
    { ...day, durations, channelMeans: means },
  );
  check('journal : une mesure plus longue que la vidéo est ramenée à sa durée',
    debord.summary.coverage.watched === 600, debord.summary.coverage.watched);

  // A video of unknown length can enter no percentage: it is counted apart
  // rather than passed over in silence.
  const inconnue = hist.buildDayJournal(
    [ligne('jour0000009', '2026-08-20T09:00:00', { source: 'takeout' })],
    { ...day, durations },
  );
  check('journal : une vidéo sans durée connue est comptée à part',
    inconnue.summary.coverage.videos === 0 && inconnue.summary.coverage.unknown === 1,
    inconnue.summary.coverage);
  check('journal : le résumé classe les lignes par provenance',
    JSON.stringify(j.summary.bySource) === '{"live":1,"takeout":1,"yt":1}',
    j.summary.bySource);

  // Stepping one day at a time through an empty week is not a reading: the
  // nearest day holding something is named on both sides.
  check('journal : le jour voisin qui porte quelque chose est trouvé',
    j.previous === at('2026-08-18T10:00:00') && j.next === at('2026-08-23T10:00:00'),
    [j.previous, j.next]);

  // The channel habit is read over the whole history, not over the day: a day
  // holding one viewing would otherwise announce a hundred percent.
  check('journal : la part regardée sur la chaîne vient de tout l’historique',
    Math.abs(j.entries[0].channelShare - 0.5) < 1e-9, j.entries[0].channelShare);
  check('journal : et dit sur combien d’ouvertures elle repose',
    j.entries[0].channelShareOpens === 1, j.entries[0].channelShareOpens);

  const vide = hist.buildDayJournal(all, {
    from: at('2026-08-21T00:00:00'), to: at('2026-08-21T23:59:59.999'),
  });
  check('journal : un jour sans rien reste un jour, pas une erreur',
    vide.entries.length === 0 && vide.summary.seconds === 0, vide.summary);

  const exclue = hist.buildDayJournal(all, {
    ...day, durations, channelMeans: means, blacklist: new Set(['Chaîne']),
  });
  check('journal : une chaîne masquée n’apparaît pas plus ici qu’ailleurs',
    exclue.entries.length === 0, exclue.entries.length);

  // The feed's own record travels beside the row. The point of the view is that
  // pairing, so the shape must survive: the page reads `feed` as null when the
  // video is not indexed.
  const { getVideosByIds } = db;
  await db.upsertVideos([{
    id: 'jour0000001', channelId: 'UCjour00000000000000000', title: 'T',
    publishedAt: at('2026-08-19T10:00:00'),
  }]);
  const found = await getVideosByIds(['jour0000001', 'jamais00000']);
  check('journal : le feed est interrogé sur les seules vidéos du jour',
    found.size === 1 && found.get('jour0000001')?.id === 'jour0000001', [...found.keys()]);
}


/**
 * The snapshot of known ids.
 *
 * It is what decides how many requests the refresh button will fire to go and
 * fetch exact dates: getting it wrong means either missing a video or asking for
 * a hundred more per channel. And it replaces a hundred database reads per
 * channel, which is why the progress bar used to drag towards the end.
 */
async function testVideosInconnues(check) {
  const cid = 'UCinconnues0000000000000';
  const avant = await db.allVideoIds();
  check('connues : un ensemble est rendu', avant instanceof Set);

  await db.upsertVideos([
    { id: 'connue-1', channelId: cid, title: 'A', publishedAt: Date.now() },
    { id: 'connue-2', channelId: cid, title: 'B', publishedAt: Date.now() },
  ]);

  const connus = await db.allVideoIds();
  check('connues : les vidéos insérées y sont',
        connus.has('connue-1') && connus.has('connue-2'));
  check('connues : rien d\'inventé', !connus.has('neuve-1'));
  check('connues : deux de plus qu\'avant', connus.size === avant.size + 2,
        { avant: avant.size, apres: connus.size });

  // This is exactly the filter the direct sweep applies.
  const neufs = ['connue-1', 'neuve-1', 'connue-2', 'neuve-2'].filter((id) => !connus.has(id));
  check('connues : seules les absentes ressortent, dans l\'ordre',
        neufs.length === 2 && neufs[0] === 'neuve-1' && neufs[1] === 'neuve-2', neufs);

  await db.deleteChannelVideos(cid);
  const apres = await db.allVideoIds();
  check('connues : la suppression se voit dans l\'instantané suivant',
        !apres.has('connue-1') && apres.size === avant.size);
}

function testScheduler(check) {
  const base = db.makeChannel(channelId(9), 'Témoin', '');
  const now = Date.now();

  check('cadence : moins de deux dates → inconnue', sch.estimateUploadInterval([BASE_TS]) === null);

  const daily = sch.estimateUploadInterval([BASE_TS, BASE_TS - DAY, BASE_TS - 2 * DAY, BASE_TS - 3 * DAY]);
  check('cadence : rythme quotidien détecté', daily === DAY, daily);

  // A channel on pause for six months then three videos in three days must not
  // be classified "half yearly": that is why we take the median.
  const bursty = sch.estimateUploadInterval([BASE_TS, BASE_TS - DAY, BASE_TS - 2 * DAY, BASE_TS - 200 * DAY]);
  check('cadence : la médiane résiste à une longue pause', bursty === DAY, bursty / DAY);

  // -- interval: flat by construction
  check('intervalle : une chaîne quelconque est relue à la période de balayage',
    sch.computeInterval(base) === sch.SWEEP_DEFAULT, sch.computeInterval(base));
  check('intervalle : une chaîne quotidienne aussi',
    sch.computeInterval({ ...base, uploadIntervalMs: DAY, lastUploadAt: now })
    === sch.SWEEP_DEFAULT);

  // This is exactly the case that made a video be missed: a channel publishing
  // every four to five months was classified dormant after ninety days, then read
  // again every few hours. It is now treated like the others.
  check('intervalle : quatre mois sans vidéo ne met pas en veille',
    sch.computeInterval({ ...base, lastUploadAt: now - 120 * DAY }) === sch.SWEEP_DEFAULT,
    sch.computeInterval({ ...base, lastUploadAt: now - 120 * DAY }));
  check('intervalle : au delà d’un an, la chaîne ralentit',
    sch.computeInterval({ ...base, lastUploadAt: now - 400 * DAY }) === sch.DORMANT_INTERVAL);
  check('intervalle : la veille se désactive',
    sch.computeInterval({ ...base, lastUploadAt: now - 400 * DAY }, now, { slowDormant: false })
    === sch.SWEEP_DEFAULT);

  check('intervalle : les échecs espacent exponentiellement',
    sch.computeInterval({ ...base, failCount: 3 }) === sch.SWEEP_DEFAULT * 8);
  check('intervalle : le recul est plafonné à un jour',
    sch.computeInterval({ ...base, failCount: 30 }) === sch.MAX_BACKOFF);
  check('intervalle : une chaîne sans vidéo longue est sondée rarement',
    sch.computeInterval({ ...base, noLongform: true }) === sch.NO_LONGFORM_INTERVAL);

  // -- coming out of a read
  const ok = sch.applyOutcome({ ...base, failCount: 4 },
    { kind: 'ok', publishedTimestamps: [BASE_TS, BASE_TS - DAY], fingerprint: 'abc' });
  check('applyOutcome : un succès efface les échecs',
    ok.failCount === 0 && ok.feedHash === 'abc' && ok.nextDueAt > now, ok.failCount);

  const gone = sch.applyOutcome({ ...base, failCount: 2 }, { kind: 'not-found' });
  check('applyOutcome : trois 404 désactivent la chaîne',
    gone.failCount === 3 && gone.active === 0, { fail: gone.failCount, active: gone.active });

  const limited = sch.applyOutcome(base, { kind: 'rate-limited', retryAfterMs: 60_000 });
  check('applyOutcome : un 429 ne pénalise pas la chaîne',
    limited.failCount === 0 && limited.nextDueAt <= now + 61_000, limited.failCount);

  // -- phase locking on the age of the copy received
  // With no locking, we come back a quarter of an hour after our read, hence at
  // random inside the cache's cycle. Starting again from the age YouTube
  // announces, we come back just after the copy is replaced: same number of
  // requests, half the mean wait.
  const sansAge = sch.computeNextDue(base, now, undefined, 0);
  check('calage : sans en tête Age, la période nominale',
    sansAge >= now + sch.SWEEP_DEFAULT && sansAge <= now + sch.SWEEP_DEFAULT + 46_000,
    Math.round((sansAge - now) / 1000) + ' s');

  // A copy ten minutes old: it expires in five, we come back then.
  const cale = sch.computeNextDue(base, now, undefined, 10 * 60_000);
  check('calage : une copie déjà vieille rapproche la relecture',
    cale - now < sch.CACHE_TTL && cale - now > 5 * 60_000,
    Math.round((cale - now) / 1000) + ' s');

  // The guard: a distributed cache can announce scattered ages, and an almost
  // expired age would bring us back within the second. Half the period is the
  // worst case allowed, hence never more than twice the nominal rhythm.
  const presqueExpire = sch.computeNextDue(base, now, undefined, sch.CACHE_TTL - 1000);
  check('calage : jamais plus vite que la moitié de la période',
    presqueExpire - now >= sch.SWEEP_DEFAULT / 2,
    Math.round((presqueExpire - now) / 1000) + ' s');

  // An aberrant age must not project the re-read hours away.
  const ageAbsurde = sch.computeNextDue(base, now, undefined, 10 * DAY);
  check('calage : un âge aberrant est ramené à la durée du cache',
    ageAbsurde - now <= sch.CACHE_TTL + 46_000,
    Math.round((ageAbsurde - now) / 1000) + ' s');

  // Over a long period, the locking aims at the end of a whole cache cycle, not
  // at some instant inside it.
  const lent = sch.computeNextDue(base, now, { sweepMs: HOUR }, 5 * 60_000);
  check('calage : à une heure de période, la relecture reste dans l’heure',
    lent - now > 30 * 60_000 && lent - now <= HOUR + 46_000,
    Math.round((lent - now) / 60_000) + ' min');

  // -- setting
  const parDefaut = sch.normalizeTuning();
  check('réglage : sans rien, dix minutes et la veille active',
    parDefaut.sweepMs === sch.SWEEP_DEFAULT && parDefaut.slowDormant === true, parDefaut);
  check('réglage : une période sous le cache est relevée',
    sch.normalizeTuning({ sweepMs: 60_000 }).sweepMs === sch.SWEEP_MIN);
  check('réglage : une période démesurée est plafonnée',
    sch.normalizeTuning({ sweepMs: 40 * HOUR }).sweepMs === sch.SWEEP_MAX);
  check('réglage : une valeur absurde retombe sur le défaut',
    sch.normalizeTuning({ sweepMs: -3 }).sweepMs === sch.SWEEP_DEFAULT
    && sch.normalizeTuning('bruit').sweepMs === sch.SWEEP_DEFAULT);

  const parHeure = sch.computeInterval(base, now, { sweepMs: HOUR });
  check('réglage : la période choisie s’applique', parHeure === HOUR, parHeure);

  // -- cost
  const cost = sch.estimateDailyCost([
    { active: 1, uploadIntervalMs: DAY, lastUploadAt: now, failCount: 0 },
    { active: 0, uploadIntervalMs: DAY, lastUploadAt: now, failCount: 0 },
  ]);
  check('coût estimé : les chaînes inactives ne comptent pas',
    cost.requestsPerDay === 144, cost);

  const cout900 = sch.estimateDailyCost(
    Array.from({ length: 900 }, () => ({ active: 1, lastUploadAt: now, failCount: 0 })),
    16_500, { sweepMs: HOUR },
  );
  check('coût estimé : neuf cents chaînes toutes les heures, environ 350 Mo',
    cout900.requestsPerDay === 21_600
    && Math.abs(cout900.bytesPerDay / 1e6 - 356) < 5,
    Math.round(cout900.bytesPerDay / 1e6) + ' Mo');

  // -- lives
  check('lives : une chaîne qui ne fait que du direct garde le régime normal',
    sch.computeInterval({ ...base, noLongform: true, livesMode: 'yes' }) === sch.SWEEP_DEFAULT,
    sch.computeInterval({ ...base, noLongform: true, livesMode: 'yes' }));
  check('lives : une chaîne sans vidéo longue ni direct reste sondée rarement',
    sch.computeInterval({ ...base, noLongform: true, livesMode: 'no' }) === sch.NO_LONGFORM_INTERVAL);

  const coutLives = sch.estimateDailyCost([
    { active: 1, uploadIntervalMs: DAY, lastUploadAt: now, failCount: 0, livesMode: 'yes' },
  ]);
  check('coût estimé : une chaîne qui diffuse coûte une requête de plus par passage',
    coutLives.requestsPerDay === 288, coutLives);

  // -- cadence sized on the list
  //
  // The thresholds are inclusive on the upper bound: five hundred channels
  // exactly stay on the fastest tier. That is the boundary one gets wrong.
  check('cadence : une petite liste part à 3 / 10',
    JSON.stringify(sch.defaultCadence(120)) === '{"alarmMinutes":3,"sweepMinutes":10}',
    sch.defaultCadence(120));
  check('cadence : cinq cents pile reste sur le palier rapide',
    sch.defaultCadence(500).sweepMinutes === 10, sch.defaultCadence(500));
  check('cadence : entre cinq cents et mille, 5 / 15',
    sch.defaultCadence(501).sweepMinutes === 15
    && sch.defaultCadence(1000).sweepMinutes === 15,
    [sch.defaultCadence(501), sch.defaultCadence(1000)]);
  check('cadence : au delà de mille, 10 / 30',
    JSON.stringify(sch.defaultCadence(2400)) === '{"alarmMinutes":10,"sweepMinutes":30}',
    sch.defaultCadence(2400));
  check('cadence : une liste vide ou absurde retombe sur le palier rapide',
    sch.defaultCadence(0).sweepMinutes === 10
    && sch.defaultCadence(NaN).sweepMinutes === 10
    && sch.defaultCadence(-4).sweepMinutes === 10);

  // Every value the popup offers must survive normalisation, otherwise the
  // setting would show one figure and collection would run on another.
  for (const minutes of [10, 15, 20, 30, 60]) {
    check(`cadence : ${minutes} min est accepté tel quel`,
      sch.normalizeTuning({ sweepMs: minutes * 60_000 }).sweepMs === minutes * 60_000);
  }
}

// ---------------------------------------------------------------------------

/** A real excerpt from a YouTube feed, cut down to two entries. */
const ATOM_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"
      xmlns:media="http://search.yahoo.com/mrss/"
      xmlns="http://www.w3.org/2005/Atom">
 <yt:playlistId>UULFaNlbnghtwlsGF-KzAFThqA</yt:playlistId>
 <title>Videos</title>
 <entry>
  <id>yt:video:ltLAZsJELng</id>
  <yt:videoId>ltLAZsJELng</yt:videoId>
  <yt:channelId>UCaNlbnghtwlsGF-KzAFThqA</yt:channelId>
  <title>Fusion nucl&#233;aire : pi&#233;ger un plasma &amp; le contenir</title>
  <author><name>ScienceEtonnante</name><uri>https://www.youtube.com/channel/UCaNlbnghtwlsGF-KzAFThqA</uri></author>
  <published>2026-06-09T05:40:36+00:00</published>
  <media:group>
   <media:title>Fusion nucl&#233;aire</media:title>
   <media:thumbnail url="https://i1.ytimg.com/vi/ltLAZsJELng/hqdefault.jpg" width="480" height="360"/>
   <media:community>
    <media:starRating count="9000" average="4.95" min="1" max="5"/>
    <media:statistics views="213453"/>
   </media:community>
  </media:group>
 </entry>
 <entry>
  <id>yt:video:V35v6HjG67U</id>
  <yt:videoId>V35v6HjG67U</yt:videoId>
  <yt:channelId>UCaNlbnghtwlsGF-KzAFThqA</yt:channelId>
  <title>Une autre vid&#xE9;o</title>
  <author><name>ScienceEtonnante</name><uri>https://www.youtube.com/channel/UCaNlbnghtwlsGF-KzAFThqA</uri></author>
  <published>2026-05-02T09:00:00+00:00</published>
  <media:group>
   <media:thumbnail url="https://i1.ytimg.com/vi/V35v6HjG67U/hqdefault.jpg" width="480" height="360"/>
   <media:community><media:statistics views="98"/></media:community>
  </media:group>
 </entry>
</feed>`;

/**
 * Takeout CSV import.
 *
 * Channel titles are free text: commas, quotes, accents, emoji. That is
 * precisely where a naive split on commas breaks, and it would break silently —
 * by importing truncated titles.
 */
function testSubscriptionsCsv(check) {
  const csv = '﻿Channel Id,Channel Url,Channel Title\n'
    + 'UCaNlbnghtwlsGF-KzAFThqA,http://www.youtube.com/channel/UCaNlbnghtwlsGF-KzAFThqA,ScienceEtonnante\n'
    + 'UCHnyfMqiRRG1u-2MsSQLbXA,http://www.youtube.com/channel/UCHnyfMqiRRG1u-2MsSQLbXA,"Veritasium, la chaîne"\n'
    + 'UCX6OQ3DkcsbYNE6H8uQQuVA,http://www.youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA,"Le ""vrai"" MrBeast"\r\n'
    + '\n'
    + 'UCwDeagCMN0rTg5-r3s9AINA,http://www.youtube.com/channel/UCwDeagCMN0rTg5-r3s9AINA,Gotaga 🎮\n';

  const { channels, skipped } = parseSubscriptionsCsv(csv);

  check('CSV : quatre abonnements lus', channels.length === 4, channels.length);
  check('CSV : la ligne d’en-tête est ignorée', skipped === 1, skipped);
  check('CSV : BOM absorbé, premier identifiant intact',
    channels[0].id === 'UCaNlbnghtwlsGF-KzAFThqA', channels[0].id);
  check('CSV : titre simple', channels[0].title === 'ScienceEtonnante', channels[0].title);
  check('CSV : virgule dans un titre entre guillemets',
    channels[1].title === 'Veritasium, la chaîne', channels[1].title);
  check('CSV : guillemets échappés',
    channels[2].title === 'Le "vrai" MrBeast', channels[2].title);
  check('CSV : fin de ligne CRLF et ligne vide gérées',
    channels[3].id === 'UCwDeagCMN0rTg5-r3s9AINA', channels[3].id);
  check('CSV : emoji préservé', channels[3].title === 'Gotaga 🎮', channels[3].title);
  check('CSV : l’URL n’est jamais prise pour un titre',
    channels.every((c) => !c.title.startsWith('http')));

  // The column order is not guaranteed: the id is recognised by its shape, never
  // by its position.
  const inverse = parseSubscriptionsCsv(
    'Titre,Lien,Identifiant\nMa chaîne,http://x/y,UCaNlbnghtwlsGF-KzAFThqA\n');
  check('CSV : colonnes dans un autre ordre',
    inverse.channels.length === 1 && inverse.channels[0].title === 'Ma chaîne',
    inverse.channels);

  const doublon = parseSubscriptionsCsv(
    'UCaNlbnghtwlsGF-KzAFThqA,,A\nUCaNlbnghtwlsGF-KzAFThqA,,B\n');
  check('CSV : doublons écartés', doublon.channels.length === 1, doublon.channels.length);

  check('CSV : fichier hors sujet ne produit rien',
    parseSubscriptionsCsv('nom,prenom\nJean,Dupont\n').channels.length === 0);
  check('CSV : fichier vide ne casse pas', parseSubscriptionsCsv('').channels.length === 0);

  // A list of URLs pasted from the address bar is a legitimate file: the id is
  // in there, merely wrapped.
  const urls = parseSubscriptionsCsv(
    'https://www.youtube.com/channel/UCaNlbnghtwlsGF-KzAFThqA\n'
    + 'https://www.youtube.com/channel/UCwDeagCMN0rTg5-r3s9AINA\n');
  check('CSV : identifiants extraits d’URL nues', urls.channels.length === 2, urls.channels.length);
  check('CSV : une URL seule ne devient pas un titre',
    urls.channels[0].title === '', urls.channels[0].title);

  const handles = parseSubscriptionsCsv('@ScienceEtonnante\n@Gotaga\n');
  check('CSV : les pseudonymes @ sont comptés comme ignorés',
    handles.channels.length === 0 && handles.skipped === 2, handles);
}

/**
 * The plan for applying a file to the account.
 *
 * This is the function that decides what will be left: its mistakes cost
 * unrecoverable subscriptions, and it is tested accordingly.
 */
function testPlanApplication(check) {
  const A = 'UCaNlbnghtwlsGF-KzAFThqA';
  const B = 'UCwDeagCMN0rTg5-r3s9AINA';
  const C = 'UCX6OQ3DkcsbYNE6H8uQQuVA';

  const fichier = [{ id: A, title: 'Science' }, { id: B, title: 'Gotaga' }];
  const compte = [{ id: B, title: 'Gotaga' }, { id: C, title: 'MrBeast' }];

  const abonner = planApplication(fichier, compte, MODES.SUBSCRIBE);
  check('Plan abonner : ne rejoint que les manquantes',
    abonner.toJoin.length === 1 && abonner.toJoin[0].id === A, abonner.toJoin);
  check('Plan abonner : ne quitte jamais rien', abonner.toLeave.length === 0);
  check('Plan abonner : les déjà abonnées sont comptées à part',
    abonner.unchanged === 1, abonner.unchanged);

  const desabonner = planApplication(fichier, compte, MODES.UNSUBSCRIBE);
  check('Plan désabonner : ne quitte que ce qui est dans le fichier et au compte',
    desabonner.toLeave.length === 1 && desabonner.toLeave[0].id === B, desabonner.toLeave);
  check('Plan désabonner : ne rejoint jamais rien', desabonner.toJoin.length === 0);

  const aligner = planApplication(fichier, compte, MODES.ALIGN);
  check('Plan aligner : rejoint les manquantes',
    aligner.toJoin.length === 1 && aligner.toJoin[0].id === A);
  check('Plan aligner : quitte les abonnements absents du fichier',
    aligner.toLeave.length === 1 && aligner.toLeave[0].id === C, aligner.toLeave);
  check('Plan aligner : le nom du compte sert quand le fichier ne le donne pas',
    aligner.toLeave[0].title === 'MrBeast', aligner.toLeave[0]);

  // A deactivated channel has already been left: treating it as a subscription
  // would make a very real subscription to recreate disappear from the plan.
  const avecInactive = planApplication(
    [{ id: A }], [{ id: A, title: 'Science', active: 0 }], MODES.SUBSCRIBE);
  check('Plan : une chaîne désactivée n’est pas un abonnement',
    avecInactive.toJoin.length === 1, avecInactive);

  const alignerInactive = planApplication(
    [{ id: B }], [{ id: C, title: 'MrBeast', active: 0 }], MODES.ALIGN);
  check('Plan aligner : une chaîne déjà quittée n’est pas requittée',
    alignerInactive.toLeave.length === 0, alignerInactive.toLeave);

  const vide = planApplication([], compte, MODES.ALIGN);
  check('Plan aligner : un fichier vide viderait tout, et le dit',
    vide.toLeave.length === 2 && vide.toJoin.length === 0, vide);

  check('Plan : entrées sans identifiant ignorées',
    planApplication([{ title: 'sans id' }, null], compte, MODES.SUBSCRIBE)
      .toJoin.length === 0);

  const doublons = planApplication(
    [{ id: A, title: 'Science' }, { id: A, title: 'Science bis' }], compte, MODES.SUBSCRIBE);
  check('Plan : un doublon ne produit qu’une action',
    doublons.toJoin.length === 1, doublons.toJoin);
}

function testRss(check) {
  check('URL : préfixe UULF appliqué',
    uploadsPlaylistId('UCaNlbnghtwlsGF-KzAFThqA') === 'UULFaNlbnghtwlsGF-KzAFThqA');
  check('URL : mode vidéos longues utilise playlist_id',
    feedUrl('UCaNlbnghtwlsGF-KzAFThqA').includes('playlist_id=UULF'));
  check('URL : mode complet utilise channel_id',
    feedUrl('UCaNlbnghtwlsGF-KzAFThqA', 'UU').includes('channel_id=UC'));

  let threw = false;
  try { uploadsPlaylistId('pas-un-id'); } catch { threw = true; }
  check('URL : un identifiant invalide échoue franchement', threw);

  const feed = parseAtomFeed(ATOM_FIXTURE);
  check('parse : deux entrées', feed.entries.length === 2, feed.entries.length);

  const [first] = feed.entries;
  check('parse : videoId', first.id === 'ltLAZsJELng', first.id);
  check('parse : channelId', first.channelId === 'UCaNlbnghtwlsGF-KzAFThqA', first.channelId);
  // The feed's title is literally "Videos" in UULF mode: the channel's name has
  // to come from the entry's author.
  check('parse : nom de chaîne pris sur l’auteur, pas sur le titre du flux',
    first.channelTitle === 'ScienceEtonnante', first.channelTitle);
  check('parse : entités numériques décodées',
    first.title === 'Fusion nucléaire : piéger un plasma & le contenir', first.title);
  check('parse : entité hexadécimale décodée',
    feed.entries[1].title === 'Une autre vidéo', feed.entries[1].title);
  check('parse : media:title n’écrase pas le titre de l’entrée',
    !first.title.startsWith('Fusion nucléaire<'), first.title);
  check('parse : date convertie en epoch',
    first.publishedAt === Date.parse('2026-06-09T05:40:36Z'), first.publishedAt);
  check('parse : miniature', first.thumbUrl.endsWith('/ltLAZsJELng/hqdefault.jpg'), first.thumbUrl);
  check('parse : vues', first.views === 213453, first.views);

  check('décodage : chaîne sans entité inchangée', decodeEntities('rien à faire') === 'rien à faire');

  // The fingerprint deliberately ignores the view counters, which move all the
  // time: otherwise no feed would ever be "unchanged".
  const same = feedFingerprint(feed.entries);
  const withNewViews = feedFingerprint(feed.entries.map((e) => ({ ...e, views: e.views + 1000 })));
  check('empreinte : insensible au compteur de vues', same === withNewViews);

  const shifted = feedFingerprint(feed.entries.map((e, i) => (i ? e : { ...e, id: 'autre' })));
  check('empreinte : change si une vidéo change', same !== shifted);
  check('empreinte : flux vide stable', feedFingerprint([]) === feedFingerprint([]));
}
