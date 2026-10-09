import * as db from '../src/lib/db.js';
import {
  runDirectSweep, runSyncTick, ingestAuthenticatedUploads,
} from '../src/background/sync-engine.js';

export async function run() {
  const results = [];
  const check = (name, pass, extra) => results.push({name, pass:Boolean(pass), extra});
  // Public metadata observed on 2026-09-11 in both Neoxi's UULF RSS and playlist.
  const channelId = 'UC_446tDNo7UckPX78hM0Nlg', target = 'Xts1bF46nt4';
  const published = '2026-09-10T09:30:18-07:00';
  const title = 'Ils s’enferment 2 ANS dans un monde ARTIFICIEL (Biosphère 2)';
  const hidden = 'hidden00001', short = 'short000001';
  const channel = {id:channelId,title:'Neoxi'};
  const settings = {syncLives:false};
  globalThis.chrome = { storage:{local:{get:async()=>({'ytfeed:settings':settings})}} };
  await db.reconcileChannels([channel]);
  await db.upsertVideos([{id:hidden,channelId,title:'Choix personnel',publishedAt:Date.parse(published)}]);
  await db.setHidden([hidden],true);
  const xml = `<feed><title>Videos</title><yt:channelId>${channelId}</yt:channelId>${[target,short,hidden].map(id=>
    `<entry><yt:videoId>${id}</yt:videoId><yt:channelId>${channelId}</yt:channelId><title>${title}</title>`+
    `<published>${published}</published><author><name>Neoxi</name></author></entry>`).join('')}</feed>`;
  const originalFetch = globalThis.fetch;
  let longCalls=0, playerCalls=0, failPlaylist=false, failAllDirect=false, authenticatedFacts=false;
  globalThis.fetch = async (url,opts) => {
    if (String(url) === 'https://www.youtube.com/') {
      return new Response('<script>ytcfg.set({"INNERTUBE_API_KEY":"local_test_key_0123456789012345"});</script>');
    }
    if (String(url).includes('/feeds/videos.xml')) return new Response(xml);
    if (String(url).includes('/player')) {
      playerCalls++;
      if (!authenticatedFacts) return new Response('{}',{status:503});
      const { videoId } = JSON.parse(opts.body);
      const isShort = videoId === 'authshort01';
      return Response.json({
        videoDetails: { videoId, title: 'Trouvé depuis l’onglet', lengthSeconds: '600', viewCount: '42' },
        microformat: { playerMicroformatRenderer: {
          canonicalUrl: `https://www.youtube.com/${isShort ? `shorts/${videoId}` : `watch?v=${videoId}`}`,
          publishDate: published,
        } },
      });
    }
    if (failAllDirect) { longCalls++; return new Response('{}',{status:403}); }
    const body = JSON.parse(opts.body);
    if(body.browseId?.startsWith('VLUUSH')) return Response.json({reelItemRenderer:{videoId:short}});
    longCalls++;
    if(failPlaylist && longCalls>1) return new Response('{}',{status:503});
    return Response.json({contents:[target,hidden].map(videoId=>({playlistVideoRenderer:{videoId}}))});
  };
  try {
    const result = await runDirectSweep({concurrency:1});
    const rows = await db.getVideosByIds([target,short,hidden]);
    const page = await db.getFeedPage();
    check('Neoxi : la vidéo RSS entre même si toutes les requêtes player échouent',
      rows.has(target) && page.items.some(v=>v.id===target),{inserted:result.inserted,playerCalls});
    check('La date exacte est conservée sans demander une nouvelle date au player',
      rows.get(target)?.publishedAt===Date.parse(published));
    check('Le rattrapage exclut les Shorts et respecte les vidéos masquées',
      !rows.has(short) && rows.get(hidden)?.hidden===1 && !page.items.some(v=>v.id===hidden));
    check('Le bilan compte réellement la vidéo récupérée',result.inserted===1,result);
    await db.deleteVideos([target]);
    failPlaylist=true;longCalls=0;
    const fallback = await runDirectSweep({concurrency:1});
    check('Une panne de playlist après la sonde ne perd pas le RSS disponible',
      (await db.getVideosByIds([target])).has(target) && fallback.inserted===1);
    failPlaylist=false;
    await db.deleteVideos([target]);
    failAllDirect=true;longCalls=0;
    const blocked = await runDirectSweep({concurrency:1});
    check('Un HTTP 403 dès la sonde lance quand même le balayage RSS complet',
      blocked.directUnavailable && blocked.checked===1 && blocked.inserted===1 &&
      (await db.getVideosByIds([target])).has(target),{blocked,longCalls});
    check('Après la sonde refusée, aucune requête directe inutile ne part par chaîne',longCalls===1,longCalls);
    failAllDirect=false;
    let stored = await db.getChannel(channelId);
    await db.putChannel({...stored,nextDueAt:0});
    await runSyncTick({concurrency:1});
    await db.deleteVideos([target]);
    stored = await db.getChannel(channelId);
    await db.putChannel({...stored,nextDueAt:0});
    const automatic = await runSyncTick({concurrency:1});
    check('La collecte automatique répare aussi un trou malgré un RSS inchangé',
      (await db.getVideosByIds([target])).has(target) && automatic.inserted===1);
    authenticatedFacts=true;
    const signed = await ingestAuthenticatedUploads(channelId, [
      {id:'authvideo01',title:'Trouvé depuis UULF'},
      {id:'authshort01',title:'Short à refuser'},
    ]);
    const signedRows = await db.getVideosByIds(['authvideo01','authshort01']);
    check('Le balayage UULF connecté insère une vidéo absente avec sa date exacte',
      signed.inserted===1 && signedRows.has('authvideo01'), signed);
    check('Le balayage UULF connecté refuse un Short confirmé par YouTube',
      !signedRows.has('authshort01') && signed.shorts===1, signed);
    authenticatedFacts=false;
    const playerCallsBeforeTabFacts=playerCalls;
    const fromTab = await ingestAuthenticatedUploads(channelId, [{
      id:'tabsigned01', title:'Validée dans l’onglet Vidéos',
      authenticatedFacts: {
        id:'tabsigned01', title:'Validée dans l’onglet Vidéos',
        publishedAt:Date.parse(published), durationSec:321, views:7,
        thumbUrl:'https://i.ytimg.com/vi/tabsigned01/hqdefault.jpg', isShort:false,
      },
    }], { backfilled: true });
    check('Les faits signés par l’onglet sont insérés sans requête player anonyme',
      fromTab.inserted===1 && playerCalls===playerCallsBeforeTabFacts
        && (await db.getVideosByIds(['tabsigned01'])).has('tabsigned01'),
      {fromTab,playerCalls,playerCallsBeforeTabFacts});
    check('Un balayage profond réussi devient le point de reprise des suivants',
      (await db.getChannel(channelId))?.directBackfillAt > 0,
      (await db.getChannel(channelId))?.directBackfillAt);
    await db.recordVideoClassification('tabrestore1', true, Date.now());
    const restoredFromTab = await ingestAuthenticatedUploads(channelId, [{
      id:'tabrestore1', title:'Vidéo normale confirmée par son onglet', sourceKind:'videos-tab',
      authenticatedFacts: {
        id:'tabrestore1', title:'Vidéo normale confirmée par son onglet',
        publishedAt:Date.parse(published), durationSec:222,
        thumbUrl:'https://i.ytimg.com/vi/tabrestore1/hqdefault.jpg', isShort:false,
      },
    }]);
    check('Une carte Vidéos ne peut pas annuler un verdict Short explicite',
      restoredFromTab.inserted===0
        && !(await db.getVideosByIds(['tabrestore1'])).has('tabrestore1'),
      restoredFromTab);
    const unknown = await ingestAuthenticatedUploads(channelId, [{
      id:'tabunknown1', title:'Verdict inconnu',
      authenticatedFacts: {
        id:'tabunknown1', publishedAt:Date.parse(published), durationSec:10, isShort:null,
      },
    }]);
    check('Un verdict Short inconnu est différé au lieu d’affaiblir le garde-fou',
      unknown.inserted===0 && unknown.deferred===1
        && !(await db.getVideosByIds(['tabunknown1'])).has('tabunknown1'), unknown);

    await db.upsertVideos([{
      id:'repair00001',channelId,title:'Présente mais incomplète',publishedAt:Date.parse(published),
    }]);
    const incompleteStops=await db.getRecentVideoIdsByChannel(100,{completeOnly:true});
    check('Une ligne RSS sans durée ne peut pas arrêter le balayage authentifié',
      !(incompleteStops.get(channelId)??[]).includes('repair00001'),
      incompleteStops.get(channelId));
    const repaired=await ingestAuthenticatedUploads(channelId,[{
      id:'repair00001',title:'Présente mais incomplète',
      authenticatedFacts:{
        id:'repair00001',title:'Présente mais incomplète',publishedAt:Date.parse(published),
        durationSec:777,views:9,thumbUrl:'https://i.ytimg.com/vi/repair00001/hqdefault.jpg',isShort:false,
      },
    }]);
    check('Le balayage complète une vidéo RSS déjà en base au lieu de l’ignorer',
      repaired.updated===1 && (await db.getVideosByIds(['repair00001'])).get('repair00001')?.durationSec===777,
      repaired);

    const restricted=await ingestAuthenticatedUploads(channelId,[{
      id:'memberonly1',title:'Réservée',membersOnly:true,
    }]);
    const resurrect=await db.upsertVideos([{
      id:'memberonly1',channelId,title:'Réservée',publishedAt:Date.parse(published),durationSec:600,
    }]);
    check('Une vidéo réservée aux membres est refusée durablement',
      restricted.members===1 && resurrect.inserted===0
        && !(await db.getVideosByIds(['memberonly1'])).has('memberonly1'),
      {restricted,resurrect});
    const publicLater=await ingestAuthenticatedUploads(channelId,[{
      id:'memberonly1',title:'Devenue publique',membersOnly:false,
      authenticatedFacts:{
        id:'memberonly1',title:'Devenue publique',publishedAt:Date.parse(published),
        durationSec:600,views:10,thumbUrl:'https://i.ytimg.com/vi/memberonly1/hqdefault.jpg',isShort:false,
      },
    }]);
    check('Une avant-première membres rejoint le feed lorsqu’elle devient publique',
      publicLater.inserted===1 && (await db.getVideosByIds(['memberonly1'])).has('memberonly1'),
      publicLater);

    // Reproduces the Short reported on 7 October 2026. GOTAGA's UULF Atom feed
    // carried `x8Jw8NGjpbY` as its newest entry — 19 seconds, canonical URL
    // `/shorts/` — while the channel's UUSH list, read at most an hour earlier,
    // did not list it yet. Only the player record settles it, and it has to be
    // asked before the row exists rather than after the card has been painted.
    const leaky='UC'+'g'.repeat(22), leak='x8Jw8NGjpbY', plain='plainlong01';
    const anHourAgo=()=>new Date(Date.now()-3600000).toISOString();
    await db.reconcileChannels([channel,{id:leaky,title:'Fuite UULF'}],{complete:true});
    const leakyXml=ids=>`<feed><title>Videos</title><yt:channelId>${leaky}</yt:channelId>${ids.map(id=>
      `<entry><yt:videoId>${id}</yt:videoId><yt:channelId>${leaky}</yt:channelId><title>Carte</title>`+
      `<published>${anHourAgo()}</published><author><name>Fuite UULF</name></author></entry>`).join('')}</feed>`;
    let leakyPlayer=0, playerDown=false;
    globalThis.fetch = async (url,opts) => {
      const u=String(url);
      if (u.includes('/feeds/videos.xml')) {
        return new Response(u.includes(leaky.slice(2)) ? leakyXml([leak,plain]) : '<feed></feed>');
      }
      if (u.includes('/player')) {
        leakyPlayer++;
        if (playerDown) return new Response('{}',{status:503});
        const {videoId}=JSON.parse(opts.body);
        const isShort=videoId===leak;
        return Response.json({
          videoDetails:{videoId,lengthSeconds:isShort?'19':'900'},
          microformat:{playerMicroformatRenderer:{
            canonicalUrl:`https://www.youtube.com/${isShort?'shorts/'+videoId:'watch?v='+videoId}`,
            publishDate:anHourAgo(),
          }},
        });
      }
      // The stale Shorts list: it does not know what was posted a moment ago.
      if (JSON.parse(opts.body).browseId?.startsWith('VLUUSH')) return Response.json({});
      return new Response('{}',{status:503});
    };
    for (const row of await db.getAllChannels()) await db.putChannel({...row,nextDueAt:0});
    await runSyncTick({concurrency:1});
    const leakRows=await db.getVideosByIds([leak,plain]);
    check('Un Short présent dans UULF que UUSH ignore encore n’entre pas',
      !leakRows.has(leak) && leakRows.has(plain), {player:leakyPlayer});
    await db.upsertVideos([{id:leak,channelId:leaky,publishedAt:Date.now(),durationSec:19}]);
    check('Le Short refusé à la collecte ne peut pas être réinséré par RSS',
      !(await db.getVideosByIds([leak])).has(leak));

    // The guard may never withhold a video on the strength of a failed request:
    // without this, a player endpoint that stops answering would silently stop
    // the feed from receiving anything new.
    await db.deleteVideos([plain]);
    playerDown=true;
    for (const row of await db.getAllChannels()) await db.putChannel({...row,nextDueAt:0});
    await runSyncTick({concurrency:1});
    check('Une panne du player n’empêche pas une vidéo RSS récente d’entrer',
      (await db.getVideosByIds([plain])).has(plain));
    playerDown=false;

    // A failed existence probe must never deactivate a valid subscription.
    globalThis.fetch = async url => new Response('', {status: String(url).includes('playlist_id=UULF') ? 404 : 500});
    for (let i=0;i<3;i++) {
      await db.putChannel({...await db.getChannel(channelId),nextDueAt:0});
      await runSyncTick({concurrency:1});
    }
    check('Trois pannes de sonde après un UULF 404 ne désactivent pas la chaîne',
      (await db.getChannel(channelId)).active===1);

    // Fifteen entries all new: the feed may have been cut, so the playlist is
    // read behind it.
    //
    // The Atom feed stops at fifteen and says nothing about it, so a channel
    // that published thirty while the browser was closed hands back the recent
    // half and the rest is lost to automatic collection for good. The two feeds
    // below differ by exactly that: fifteen entries in Atom, twenty in the
    // playlist.
    const fullChannel = 'UC'+'F'.repeat(22);
    const fullIds = Array.from({length:20},(_,i)=>`overflow${String(i).padStart(3,'0')}`);
    const fullStamp = new Date().toISOString();
    const fullXml = `<feed><title>Videos</title><yt:channelId>${fullChannel}</yt:channelId>`+
      fullIds.slice(0,15).map(id=>`<entry><yt:videoId>${id}</yt:videoId>`+
        `<yt:channelId>${fullChannel}</yt:channelId><title>Vidéo ${id}</title>`+
        `<published>${fullStamp}</published><author><name>Chaîne pleine</name></author></entry>`).join('')+
      '</feed>';
    await db.reconcileChannels([{id:fullChannel,title:'Chaîne pleine'}],{complete:true});
    // Already read once: a channel seen for the first time is deliberately out
    // of this, since everything is new there by construction.
    await db.putChannel({...await db.getChannel(fullChannel),
      nextDueAt:0, lastSuccessAt:Date.now()-60000, videoCount:1});
    let playlistReads = 0, playlistDown = false;
    globalThis.fetch = async (url,opts) => {
      const target = String(url);
      if (target.includes('/feeds/videos.xml')) {
        return new Response(target.includes(`UULF${fullChannel.slice(2)}`) ? fullXml
          : '<feed><title>Videos</title></feed>');
      }
      if (target.includes('/player')) {
        const { videoId } = JSON.parse(opts.body);
        return Response.json({
          videoDetails:{videoId,title:`Vidéo ${videoId}`,lengthSeconds:'900',viewCount:'10'},
          microformat:{playerMicroformatRenderer:{
            canonicalUrl:`https://www.youtube.com/watch?v=${videoId}`, publishDate:fullStamp}},
        });
      }
      const body = JSON.parse(opts.body ?? '{}');
      if (body.browseId?.startsWith('VLUUSH')) return Response.json({});
      if (body.browseId === `VLUULF${fullChannel.slice(2)}`) {
        playlistReads++;
        if (playlistDown) return new Response('{}',{status:503});
        return Response.json({contents:fullIds.map(videoId=>({playlistVideoRenderer:{videoId}}))});
      }
      return new Response('{}',{status:503});
    };
    await runSyncTick({concurrency:1});
    const apresPlein = await db.getVideosByIds(fullIds);
    check('Un flux Atom saturé fait lire la playlist derrière lui', playlistReads === 1, playlistReads);
    check('Les vidéos au delà de la quinzième entrent quand même',
      fullIds.every(id=>apresPlein.has(id)), {connues:apresPlein.size});
    check('La chaîne ne garde pas de dette une fois rattrapée',
      (await db.getChannel(fullChannel))?.overflowAt === undefined);

    // The same saturation, with the playlist refusing: the debt has to survive
    // the tick, because the fifteen entries are in the database by now and the
    // next read can no longer tell that anything was cut.
    await db.deleteVideos(fullIds);
    playlistDown = true; playlistReads = 0;
    await db.putChannel({...await db.getChannel(fullChannel),
      nextDueAt:0, feedHash:null, lastSuccessAt:Date.now()-60000});
    await runSyncTick({concurrency:1});
    check('Une playlist en panne laisse la dette sur la chaîne',
      playlistReads === 1 && Number.isFinite((await db.getChannel(fullChannel))?.overflowAt));

    playlistDown = false;
    await db.putChannel({...await db.getChannel(fullChannel),nextDueAt:0,feedHash:null});
    await runSyncTick({concurrency:1});
    check('La dette est honorée au balayage suivant, sans nouvelle saturation',
      (await db.getVideosByIds(fullIds)).size === 20
      && (await db.getChannel(fullChannel))?.overflowAt === undefined);

    // A channel whose live feed answered empty is read again on the next sweep.
    //
    // It used to wait a fortnight: an empty or missing UULV wrote `livesMode`
    // "no" and pushed the next probe two weeks out, so a channel that started
    // broadcasting in between was invisible until the delay ran out. Measured
    // on 8 October 2026, `Co7jh46dJ7w` reached the reverse audit that way. The
    // two sweeps below are the whole test: nothing changes between them except
    // what the live feed answers.
    const liveChannel = 'UC'+'L'.repeat(22), liveId = 'livevideo01';
    const liveFeed = (entries) => `<feed><title>Videos</title><yt:channelId>${liveChannel}</yt:channelId>`+
      entries.map(id=>`<entry><yt:videoId>${id}</yt:videoId><yt:channelId>${liveChannel}</yt:channelId>`+
        `<title>En direct</title><published>${new Date().toISOString()}</published>`+
        `<author><name>Chaîne live</name></author></entry>`).join('')+'</feed>';
    settings.syncLives = true;
    await db.reconcileChannels([{id:liveChannel,title:'Chaîne live'}],{complete:true});
    let liveProbes = 0, liveEntries = [];
    globalThis.fetch = async url => {
      const target = String(url);
      if (target.includes(`playlist_id=UULV${liveChannel.slice(2)}`)) {
        liveProbes++;
        return new Response(liveFeed(liveEntries));
      }
      if (target.includes('/feeds/videos.xml')) return new Response(liveFeed([]));
      return new Response('{}',{status:503});
    };
    await runSyncTick({concurrency:1});
    check('Un flux de lives vide note la chaîne comme silencieuse',
      (await db.getChannel(liveChannel))?.livesMode === 'no' && liveProbes === 1, liveProbes);
    check('Aucune date de sonde séparée ne subsiste sur la chaîne',
      (await db.getChannel(liveChannel))?.livesNextDueAt === undefined);

    liveEntries = [liveId];
    for (const row of await db.getAllChannels()) await db.putChannel({...row,nextDueAt:0});
    await runSyncTick({concurrency:1});
    check('Le premier direct d’une chaîne silencieuse est vu au balayage suivant',
      liveProbes === 2 && (await db.getVideosByIds([liveId])).has(liveId), liveProbes);
    check('La chaîne passe à l’état « diffuse » dès ce direct',
      (await db.getChannel(liveChannel))?.livesMode === 'yes');
    settings.syncLives = false;

    // Complete: this section counts requests, so it needs the account to hold
    // exactly these two channels and no leftover from the sections above.
    await db.reconcileChannels([channel,{id:'UC'+'z'.repeat(22),title:'Next'}],{complete:true});
    for (const row of await db.getAllChannels()) await db.putChannel({...row,nextDueAt:0});
    let rateCalls=0;
    globalThis.fetch = async () => {rateCalls++;return new Response('',{status:429});};
    const limited=await runSyncTick({concurrency:1});
    check('Un 429 arrête les nouvelles requêtes et expose les chaînes restantes',
      rateCalls===1 && limited.aborted && limited.remaining===1, {rateCalls,limited});
  } finally { globalThis.fetch=originalFetch; }
  return results;
}
