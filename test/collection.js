import * as db from '../src/lib/db.js';
import { collectChannelWindow } from '../src/content/channel-sweep.js';
import { ingestAuthenticatedUploads } from '../src/background/sync-engine.js';
import { screenFeedVideos } from '../src/background/shorts.js';
import { mergeVideoTabEntries, channelTabBody } from '../src/lib/innertube-parse.js';

export async function run() {
  const results = [];
  const check = (name, pass, extra) => results.push({ name, pass: Boolean(pass), extra });
  const channelId = 'UC' + 'x'.repeat(22), normal = 'normal00001', short = 'RJBW_Ad_20A';
  const now = Date.now();
  globalThis.chrome = {
    runtime: { id: 'bench', getURL: p => '/' + p, sendMessage: async () => ({ok: true}),
      onMessage: { addListener() {} } },
    storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
    tabs: { query: async () => [], sendMessage: async () => ({}) },
  };
  await db.reconcileChannels([{ id: channelId, title: 'Fixture', avatarUrl: 'https://yt3.ggpht.com/avatar' }]);
  await db.upsertVideos([
    {id: normal, channelId, publishedAt: now, durationSec: 12},
    {id: short, channelId, title: 'Etoiles 😭', publishedAt: now, durationSec: 31},
  ]);
  const originalFetch = globalThis.fetch;
  let playerCalls = 0;
  globalThis.fetch = async (url, opts) => {
    playerCalls++;
    const { videoId } = JSON.parse(opts.body);
    return Response.json({ videoDetails: { videoId, lengthSeconds: '31' },
      microformat: { playerMicroformatRenderer: {
        canonicalUrl: `https://www.youtube.com/${videoId === short ? 'shorts/' + short : 'watch?v=' + videoId}`,
      } } });
  };
  try {
    const screened = await screenFeedVideos([normal, short]);
    check('RJBW_Ad_20A : le canonique /shorts/ exclut même si UUSH ne le contient pas',
      screened.items.length === 1 && screened.items[0].id === normal);
    const callsBefore = playerCalls;
    await screenFeedVideos([normal]);
    check('Le verdict normal frais évite une nouvelle requête player', playerCalls === callsBefore);
    check('Une vidéo ordinaire de 12 secondes est conservée', (await db.getVideosByIds([normal])).has(normal));
    await db.upsertVideos([{id: short, channelId, publishedAt: now, durationSec: 31}]);
    check('RSS ne ressuscite pas le Short exclu par le canonique', !(await db.getVideosByIds([short])).has(short));

    const tabCalls = [], persisted = [];
    const video = (id, durationSec = 600) => ({id, sourceKind: 'videos-tab', title: id, publishedAt: now, durationSec});
    const outcome = await collectChannelWindow([{id: channelId, knownIds: [normal], includeLives: true}], {
      now,
      fetchTab: async (id, options) => {
        tabCalls.push(options);
        return {ok: true, coveredWindow: true, videos: options.kind === 'lives'
          ? [{...video('live0000001'), sourceKind: 'lives-tab', wasLive: true}]
          : [video(normal), video('missing0001'), video(short, 31)]};
      },
      fetchUploads: async () => { throw new Error('No fallback expected'); },
      fetchFacts: async id => ({id, publishedAt: now, durationSec: 31, isShort: id === short}),
      persist: async payload => { persisted.push(payload); return {ok: true,
        ...await ingestAuthenticatedUploads(payload.channelId, payload.videos)}; },
    });
    check('Le balayage lit Vidéos et En direct même sans livesMode connu',
      tabCalls.length === 2 && tabCalls[1].kind === 'lives', tabCalls);
    check('Un identifiant connu ne coupe pas la fenêtre de sept jours',
      tabCalls.every(call => call.since === now - 8 * 86400e3 && !call.stopAtIds?.length));
    check('La collecte retrouve une vidéo ordinaire et une rediffusion absentes',
      outcome.inserted === 2 && (await db.getVideosByIds(['missing0001', 'live0000001'])).size === 2, outcome);
    check('La présence dans Vidéos ne réintroduit pas RJBW_Ad_20A',
      !(await db.getVideosByIds([short])).has(short));
    check('Le point de contrôle indique la fenêtre réellement parcourue',
      persisted[0].coverage.since === now - 8 * 86400e3 && !persisted[0].coverage.partial);
    const failure = await collectChannelWindow([{id: channelId}], {
      fetchTab: async () => { throw new Error('Simulated network failure'); },
      fetchUploads: async () => ({ok: false, videos: []}),
      fetchFacts: async () => null, persist: async () => ({ok: true}),
    });
    check('Une exception de worker apparaît dans le bilan', failure.errors === 1 && failure.checked === 0, failure);
    const fallback = await collectChannelWindow([{id: channelId}], {
      fetchTab: async () => ({ok: false, videos: []}),
      fetchUploads: async () => ({ok: true, videos: []}),
      fetchFacts: async () => null, persist: async () => ({ok: true}),
    });
    check('Le fallback borné ne prétend pas avoir couvert la semaine', fallback.partial === 1, fallback);
    const merged = mergeVideoTabEntries([video(normal)], [video(normal), video('recommended')]);
    check('Une recommandation hors grille ne devient pas une vidéo de la chaîne',
      merged.length === 1 && merged[0].id === normal, merged);

    // Exercise the real pagination client, with deterministic response pages.
    const { fetchChannelVideosTab } = await import('../src/content/innertube.js');
    const card = (id, age) => ({richItemRenderer: {content: {videoRenderer: {
      videoId: id, title: {simpleText: id}, publishedTimeText: {simpleText: age},
      lengthText: {simpleText: '10:00'},
    } } } });
    const next = token => ({continuationItemRenderer: {continuationEndpoint: {continuationCommand: {token}}}});
    let browseCalls = 0, failSecond = false, repeatToken = false;
    globalThis.fetch = async (url, opts) => {
      browseCalls++;
      const body = JSON.parse(opts.body);
      if (body.continuation && failSecond) return new Response('{}', {status: 503});
      const contents = body.continuation
        ? [card('pagehole001', repeatToken ? '1 day ago' : '9 days ago'), ...(repeatToken ? [next('page2')] : [])]
        : [card(normal, '1 day ago'), next('page2')];
      return Response.json(body.continuation
        ? {onResponseReceivedActions: [{appendContinuationItemsAction: {continuationItems: contents}}]}
        : {contents: {richGridRenderer: {contents}}});
    };
    const paged = await fetchChannelVideosTab(channelId, {max: 1200, stopAtIds: [normal], since: now - 8 * 86400e3});
    check('Le vrai client continue après une carte connue et récupère la page suivante',
      browseCalls === 2 && paged.videos.some(v => v.id === 'pagehole001') && paged.coveredWindow, paged);
    failSecond = true; browseCalls = 0;
    const interrupted = await fetchChannelVideosTab(channelId, {max: 1200, since: now - 8 * 86400e3});
    check('Une panne de continuation conserve les découvertes et signale la couverture partielle',
      interrupted.ok && interrupted.partial && !interrupted.coveredWindow && interrupted.reason === 'request-failed', interrupted);
    failSecond = false; repeatToken = true; browseCalls = 0;
    const repeated = await fetchChannelVideosTab(channelId, {max: 1200, since: now - 8 * 86400e3});
    check('Un token répété arrête la pagination sans déclarer une couverture complète',
      repeated.partial && repeated.reason === 'no-progress' && browseCalls === 2, repeated);
    repeatToken = false; browseCalls = 0;
    const capped = await fetchChannelVideosTab(channelId, {max: 1, since: now - 8 * 86400e3});
    check('Un plafond atteint est exposé comme une collecte partielle', capped.partial && browseCalls === 1, capped);
    const tabs = (...tabs) => ({contents:{twoColumnBrowseResultsRenderer:{tabs:tabs.map(tabRenderer=>({tabRenderer}))}}});
    const home = {title:'Home',selected:true,content:{richGridRenderer:{contents:[card('recommend01','1 day ago')]}}};
    check('Un retour Home sans onglet Live ne prétend pas être une liste de directs',
      channelTabBody(tabs(home), 'lives').absent===true);
    check('Un onglet Vidéos non sélectionné ne fournit pas les recommandations de Home',
      channelTabBody(tabs(home,{title:'Videos'})).body===null);
    globalThis.fetch = async () => Response.json({unknownTemplate:{videoId:'recommend01'}});
    const malformed = await fetchChannelVideosTab(channelId,{since:now-8*86400e3});
    check('Une réponse non reconnue ne donne pas une fausse couverture complète',
      !malformed.ok && malformed.partial, malformed);

    await db.upsertVideos([{id:'dateapprox1',channelId,publishedAt:now,publishedAtApprox:true,durationSec:300}]);
    await db.upsertVideos([{id:'dateapprox1',channelId,publishedAt:now-3600000,source:'rss'}]);
    await db.upsertVideos([{id:'dateapprox1',channelId,publishedAt:now,publishedAtApprox:true}]);
    const dated = (await db.getVideosByIds(['dateapprox1'])).get('dateapprox1');
    check('Une date exacte remplace la date relative sans dégradation ultérieure',
      dated.publishedAt===now-3600000 && dated.publishedAtApprox===false, dated);
    await db.upsertVideos([{id:'unresolved1',channelId,publishedAt:now}]);
    await db.recordNativeVideos([{id:'unresolved1',publishedAt:now}],now,{replace:true});
    const {runReverseAudit}=await import('../src/background/audit.js');
    const audit=await runReverseAudit();
    check('Le diagnostic distingue une vidéo connue mais retenue pour métadonnées',
      audit.missingCount===0 && audit.presentCount===1 && audit.unresolvedCount===1, audit);
  } finally { globalThis.fetch = originalFetch; }
  return results;
}
