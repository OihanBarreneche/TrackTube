import * as db from '../src/lib/db.js';
import { collectChannelWindow } from '../src/content/channel-sweep.js';
import { ingestAuthenticatedUploads, ingestChannelRssFallback } from '../src/background/sync-engine.js';
import { screenFeedVideos } from '../src/background/shorts.js';
import {
  mergeVideoTabEntries, channelTabBody, isEmptyChannelTab, extractPlayerFacts,
} from '../src/lib/innertube-parse.js';

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
    if (String(url) === 'https://www.youtube.com/') {
      return new Response('<script>ytcfg.set({"INNERTUBE_API_KEY":"local_test_key_0123456789012345"});</script>');
    }
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
    window.addEventListener('message', event => {
      const message = event.data;
      if (message?.source !== 'tracktube-iso' || message.type !== 'innertube-config') return;
      window.postMessage({source: 'tracktube-main', type: 'innertube-config', payload: {
        requestId: message.requestId,
        key: 'local_test_key_0123456789012345',
        context: {client: {clientName: 'WEB', clientVersion: '2.20261008.01.00'}},
      }}, window.location.origin);
    });
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
    // The shape YouTube returned for Mister V on 27 October 2026: the Search tab
    // closes the list as an expandableTabRenderer, and refusing it sent 922 of
    // 934 deep reads on a real profile to the playlist fallback.
    const tab = (title, path, extra = {}) => ({tabRenderer: {title,
      endpoint: {commandMetadata: {webCommandMetadata: {url: `/@mistervofficial/${path}`}}}, ...extra}});
    const grid = {richGridRenderer: {contents: [card('vraievideo1', '1 day ago')]}};
    const search = {expandableTabRenderer: {title: 'Search', selected: false,
      endpoint: {commandMetadata: {webCommandMetadata: {url: '/@mistervofficial/search'}}}}};
    const realVideos = {contents: {twoColumnBrowseResultsRenderer: {tabs: [
      tab('Home', 'featured'), tab('Videos', 'videos', {selected: true, content: grid}),
      tab('Shorts', 'shorts'), tab('Playlists', 'playlists'), tab('Posts', 'posts'), search]}}};
    check('L’onglet Recherche ne fait plus refuser la réponse de l’onglet Vidéos',
      channelTabBody(realVideos).body === grid);
    const realStreams = {contents: {twoColumnBrowseResultsRenderer: {tabs: [
      tab('Home', 'featured', {selected: true, content: grid}), tab('Videos', 'videos'),
      tab('Shorts', 'shorts'), tab('Playlists', 'playlists'), tab('Posts', 'posts'), search]}}};
    check('Sans onglet En direct, la même réponse est lue comme absente et non comme une grille',
      channelTabBody(realStreams, 'lives').absent === true && channelTabBody(realStreams, 'lives').body === null);
    const unknownKind = {contents: {twoColumnBrowseResultsRenderer: {tabs: [
      tab('Videos', 'videos', {selected: true, content: grid}), {mysteryTabRenderer: {title: 'Live'}}]}}};
    check('Un type d’onglet inconnu refuse toujours, sans certifier une absence',
      channelTabBody(unknownKind, 'lives').body === null && channelTabBody(unknownKind, 'lives').absent === false);
    globalThis.fetch = async () => Response.json({unknownTemplate:{videoId:'recommend01'}});
    const malformed = await fetchChannelVideosTab(channelId,{since:now-8*86400e3});
    check('Une réponse non reconnue ne donne pas une fausse couverture complète',
      !malformed.ok && malformed.partial, malformed);
    // The Live tab of a channel whose streams are all gone, as YouTube answered
    // it for 11 of 597 channels on 30 October 2026: selected, and empty in so
    // many words. It used to fall back on the playlist and make every sweep
    // report « Collecte partielle » with 597 of 597 channels read.
    const emptyState = {sectionListRenderer: {contents: [{channelOwnerEmptyStateRenderer: {
      description: {simpleText: 'This channel has no videos.'}}}], disablePullToRefresh: true}};
    globalThis.fetch = async () => Response.json({contents: {twoColumnBrowseResultsRenderer: {tabs: [
      tab('Home', 'featured'), tab('Videos', 'videos'),
      tab('Live', 'streams', {selected: true, content: emptyState}), tab('Playlists', 'playlists'), search]}}});
    const emptyLive = await fetchChannelVideosTab(channelId, {kind: 'lives', since: now - 8 * 86400e3});
    check('Un onglet En direct vide est une fenêtre couverte, sans secours ni « partielle »',
      emptyLive.ok && emptyLive.coveredWindow && !emptyLive.partial && emptyLive.reason === 'tab-empty'
        && emptyLive.videos.length === 0, emptyLive);
    check('Une liste de sections qui contient autre chose qu’un état vide reste non reconnue',
      !isEmptyChannelTab({sectionListRenderer: {contents: [emptyState.sectionListRenderer.contents[0],
        {itemSectionRenderer: {contents: [{messageRenderer: {text: {simpleText: 'Try again'}}}]}}]}}));
    // The anonymous player's two wordings for a members-only video, read on 30
    // October 2026, and its answer for a public one on the same request.
    const playerSays = (reason) => extractPlayerFacts({playabilityStatus: {status: 'UNPLAYABLE', reason},
      videoDetails: {videoId: 'membcheck01', lengthSeconds: '600'},
      microformat: {playerMicroformatRenderer: {canonicalUrl: 'https://www.youtube.com/watch?v=membcheck01'}}},
      'membcheck01').membersOnly;
    check('Le lecteur reconnaît les deux formulations Membres et pas une vidéo publique',
      playerSays('Join this channel to get access to members-only content like this video, and other exclusive perks.')
        && playerSays('This video is available to this channel\'s members on level: Bonus (or any higher level).')
        && !playerSays('Video unavailable'));

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

    // A Short whose first verification came back inconclusive got a row, and
    // that row used to exempt it from every later collection pass: the filter
    // asked whether the video was stored, not whether its verdict still held.
    // Only the display screening could still recognise it, and that runs on
    // what is already painted. Measured on 26 October 2026 with yjEuPhcexEs,
    // 78 seconds, present in its channel's UULF and absent from its UUSH.
    const lateChannel = 'UC' + 'y'.repeat(22);
    const lateShort = 'yjEuPhcexEs', lateNormal = 'latenormal1';
    await db.reconcileChannels([{id: lateChannel, title: 'MVP'}], {complete: false});
    await db.upsertVideos([
      // No verdict at all: exactly the row a failed player request leaves.
      {id: lateShort, channelId: lateChannel, title: 'Short passé entre les mailles',
        publishedAt: now - 3600e3, durationSec: 78},
      {id: lateNormal, channelId: lateChannel, title: 'Vidéo ordinaire',
        publishedAt: now - 3600e3, durationSec: 900},
    ]);
    const lateFeed = `<feed><title>Videos</title><yt:channelId>${lateChannel}</yt:channelId>`
      + [lateShort, lateNormal].map((id) => `<entry><yt:videoId>${id}</yt:videoId>`
        + `<yt:channelId>${lateChannel}</yt:channelId><title>Entrée</title>`
        + `<published>${new Date(now - 3600e3).toISOString()}</published>`
        + '<author><name>MVP</name></author></entry>').join('') + '</feed>';
    let latePlayerCalls = 0;
    globalThis.fetch = async (url, opts) => {
      const target = String(url);
      if (target === 'https://www.youtube.com/') {
        return new Response('<script>ytcfg.set({"INNERTUBE_API_KEY":"local_test_key_0123456789012345"});</script>');
      }
      if (target.includes('/feeds/videos.xml')) return new Response(lateFeed);
      if (target.includes('/player')) {
        latePlayerCalls++;
        const { videoId } = JSON.parse(opts.body);
        const short = videoId === lateShort;
        return Response.json({
          videoDetails: { videoId, lengthSeconds: short ? '78' : '900' },
          microformat: { playerMicroformatRenderer: {
            canonicalUrl: `https://www.youtube.com/${short ? 'shorts/' + videoId : 'watch?v=' + videoId}`,
            publishDate: new Date(now - 3600e3).toISOString(),
          } },
        });
      }
      // The companion UUSH list deliberately answers empty: this is the case
      // where membership cannot settle it and only the canonical URL can.
      return Response.json({});
    };
    await ingestChannelRssFallback(lateChannel);
    check('Un Short déjà stocké sans verdict est revérifié à la collecte, pas seulement à l’affichage',
      !(await db.getVideosByIds([lateShort])).has(lateShort), latePlayerCalls);
    check('La vidéo ordinaire de la même lecture est conservée',
      (await db.getVideosByIds([lateNormal])).has(lateNormal));
    // And the verdict just recorded has to stop the requests, or every cycle
    // would re-ask about every recent row for ever.
    const settled = latePlayerCalls;
    await ingestChannelRssFallback(lateChannel);
    check('Un verdict négatif encore valide évite une nouvelle requête player',
      latePlayerCalls === settled, {settled, after: latePlayerCalls});

    // A Members first video: flagged while reserved, public later, and carried
    // by Atom from then on. The flag used to be lifted only by the tab's window
    // sweep, which reached GX6AdHXAfY4 fifteen and a half hours after the feed
    // did on 28 October 2026. An unbadged Videos tab card read at collection
    // lifts it now; a badged one, or no answer, does not.
    const memberChannel = 'UC' + 'z'.repeat(22);
    const memberVideo = 'membfirst01';
    await db.reconcileChannels([{id: memberChannel, title: 'JDE'}], {complete: false});
    await db.recordMembersOnly(memberVideo, true, now - 86400e3);
    const memberFeed = `<feed><title>Videos</title><yt:channelId>${memberChannel}</yt:channelId>`
      + `<entry><yt:videoId>${memberVideo}</yt:videoId><yt:channelId>${memberChannel}</yt:channelId>`
      + `<title>Le Journal</title><published>${new Date(now - 2 * 3600e3).toISOString()}</published>`
      + '<author><name>JDE</name></author></entry></feed>';
    let badged = true, tabReads = 0, tabAnswers = true;
    globalThis.fetch = async (url, opts) => {
      const target = String(url);
      if (target === 'https://www.youtube.com/') {
        return new Response('<script>ytcfg.set({"INNERTUBE_API_KEY":"local_test_key_0123456789012345"});</script>');
      }
      if (target.includes('/feeds/videos.xml')) return new Response(memberFeed);
      const body = JSON.parse(opts.body);
      if (target.includes('/player')) {
        return Response.json({ videoDetails: { videoId: body.videoId, lengthSeconds: '1097' },
          microformat: { playerMicroformatRenderer: {
            canonicalUrl: `https://www.youtube.com/watch?v=${body.videoId}`,
            publishDate: new Date(now - 2 * 3600e3).toISOString() } } });
      }
      if (body.params === 'EgZ2aWRlb3PyBgQKAjoA') {
        tabReads++;
        if (!tabAnswers) return new Response('{}', {status: 503});
        const renderer = {videoId: memberVideo, title: {simpleText: 'Le Journal'},
          publishedTimeText: {simpleText: '2 hours ago'}, lengthText: {simpleText: '18:17'},
          ...(badged ? {badges: [{metadataBadgeRenderer: {style: 'BADGE_STYLE_TYPE_MEMBERS_ONLY',
            label: 'Members first'}}]} : {})};
        return Response.json({contents: {twoColumnBrowseResultsRenderer: {tabs: [
          tab('Videos', 'videos', {selected: true, content: {richGridRenderer: {contents: [
            {richItemRenderer: {content: {videoRenderer: renderer}}}]}}}), search]}}});
      }
      return Response.json({});
    };
    const memberRow = async () => (await db.getVideosByIds([memberVideo])).has(memberVideo);
    await ingestChannelRssFallback(memberChannel);
    check('Encore badgée Membres dans l’onglet Vidéos, la vidéo reste refusée',
      !(await memberRow()) && tabReads === 1, tabReads);
    await ingestChannelRssFallback(memberChannel);
    check('L’onglet n’est pas redemandé avant la demi heure', tabReads === 1, tabReads);
    await db.metaSet(`members.recheck.${memberChannel}`, {nextAt: 0});
    badged = false; tabAnswers = false;
    await ingestChannelRssFallback(memberChannel);
    check('Un onglet qui ne répond pas ne lève rien', !(await memberRow()) && tabReads === 2, tabReads);
    await db.metaSet(`members.recheck.${memberChannel}`, {nextAt: 0});
    tabAnswers = true;
    await ingestChannelRssFallback(memberChannel);
    check('Devenue publique, elle entre à la lecture Atom suivante sans attendre le balayage',
      await memberRow(), tabReads);
  } finally { globalThis.fetch = originalFetch; }
  return results;
}
