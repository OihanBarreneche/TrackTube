import * as db from '../src/lib/db.js';
import { extractPlaylistVideos, isShort } from '../src/lib/innertube-parse.js';
import { getScreenedFeedPage, verifiedFeedVideos, refreshChannelShorts } from '../src/background/shorts.js';

export async function run() {
  const results = [];
  const check = (name, pass, extra) => results.push({ name, pass: Boolean(pass), extra });
  const real = await (await fetch('/test/shorts-lockup.json')).json();
  const samples = await (await fetch('/test/player-classifications.json')).json();
  check('Le nouveau format Shorts réel est reconnu', extractPlaylistVideos(real)[0]?.id === 'Q1jZMoNK9Yc');
  check('Le format Shorts précédent reste reconnu', extractPlaylistVideos({reelItemRenderer:{videoId:'oldShort001'}})[0]?.id === 'oldShort001');
  for (const sample of samples.samples) check('Classification publique exacte : '+sample.videoDetails.videoId,
    isShort(sample, sample.videoDetails.videoId) === sample.expectedShort);
  const channelId = 'UC' + 'x'.repeat(22);
  const normalId = 'normal00001', shortId = 'Q1jZMoNK9Yc', continuedId = 'nextShort01';
  await db.reconcileChannels([{ id: channelId, title: 'Test' }]);
  const rows = Array.from({length:9000}, (_,i)=>({id:String(i).padStart(11,'v'),channelId,
    title:'Video '+i,publishedAt:Date.now()-i*1000,durationSec:null}));
  rows.push({id:normalId,channelId,title:'Une vidéo ordinaire #shorts',publishedAt:Date.now(),durationSec:12},
    {id:shortId,channelId,publishedAt:Date.now(),durationSec:600},
    {id:continuedId,channelId,publishedAt:Date.now(),durationSec:25});
  await db.upsertVideos(rows);
  const originalFetch = globalThis.fetch;
  let calls=0, playerCalls=0, fail=false;
  globalThis.fetch = async (url, opts)=>{
    calls++;
    if(String(url).includes('/player')) {playerCalls++; throw Error('No player expected');}
    if(fail) return new Response('{}',{status:503});
    const body = JSON.parse(opts.body);
    if(body.continuation) return new Response(JSON.stringify({reelItemRenderer:{videoId:continuedId}}));
    return new Response(JSON.stringify({contents:[real,{continuationItemRenderer:{continuationEndpoint:{continuationCommand:{token:'next'}}}}],
      recommendations:{lockupViewModel:{contentId:normalId,contentType:'LOCKUP_CONTENT_TYPE_VIDEO'}}}));
  };
  try {
    await Promise.all([refreshChannelShorts(channelId),refreshChannelShorts(channelId)]);
    check('Une seule lecture paginée par chaîne, même avec deux demandes simultanées',calls===2,calls);
    const stored = await db.getVideosByIds([normalId,shortId,continuedId]);
    check('Seuls les identifiants de la liste Shorts sont exclus, quelle que soit leur durée',stored.has(normalId)&&!stored.has(shortId)&&!stored.has(continuedId));
    await db.upsertVideos(rows.slice(-3));
    check('Une synchronisation ne réintroduit pas un Short connu',!(await db.getVideosByIds([shortId])).has(shortId));
    await refreshChannelShorts(channelId);
    check('La liste de chaîne est persistée en cache',calls===2);
    fail=true;
    const started=performance.now();
    const page=await getScreenedFeedPage({limit:60,requireComplete:true});
    const elapsed=performance.now()-started;
    check('Le garde-fou retient les durées inconnues mais conserve une vidéo sans avatar, sans appel réseau',
      page.items.length===1&&page.items[0].id===normalId&&page.withheldCount===9000&&elapsed<1000,
      {elapsed:Math.round(elapsed),items:page.items.length,withheld:page.withheldCount});
    const openPage=await getScreenedFeedPage({limit:60,requireComplete:false});
    check('Lire et paginer la base sans garde-fou ne déclenche aucun appel réseau',
      (await verifiedFeedVideos([normalId])).length===1 &&
      (await getScreenedFeedPage({limit:60,after:openPage.nextCursor})).items.length===60&&calls===2&&playerCalls===0);
    const failedChannel='UC'+'y'.repeat(22);
    await refreshChannelShorts(failedChannel);
    await refreshChannelShorts(failedChannel);
    check('Un échec réseau ne crée pas une boucle de requêtes',calls===3);
    check('Un échec réseau laisse les vidéos normales disponibles',
      (await verifiedFeedVideos([normalId])).length===1);
  } finally {globalThis.fetch=originalFetch;}
  return results;
}
