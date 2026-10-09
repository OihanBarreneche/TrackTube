import * as db from '../src/lib/db.js';
import { MSG } from '../src/lib/messages.js';
import { getScreenedFeedPage, verifiedFeedVideos } from '../src/background/shorts.js';

export async function run() {
  const results=[];
  const check=(name,pass,extra)=>results.push({name,pass:Boolean(pass),extra});
  const channelId='UC'+'x'.repeat(22), normalId='ordinary001';
  const channel={
    id:channelId,title:'Test',
    avatarUrl:'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/%3E',
  };
  const listeners=[];
  let pageCalls=0, screenCalls=0, release;
  const unavailable=new Promise(r=>{release=r;});
  globalThis.chrome={
    runtime:{id:'bench',getManifest:()=>({version:'test'}),
      getURL:p=>p==='src/content/innertube.js'?'/test/shorts-innertube.js':'/'+p,
      onMessage:{addListener:fn=>listeners.push(fn)},
      sendMessage:async msg=>{
        switch(msg.type){
          case MSG.GET_CHANNELS:return {ok:true,channels:[channel]};
          case MSG.GET_FEED_PAGE:pageCalls++;return {ok:true,...await getScreenedFeedPage(msg)};
          case MSG.SCREEN_SHORTS:screenCalls++;await unavailable;return {ok:true,items:await verifiedFeedVideos(msg.ids)};
          case MSG.GET_FEED_COUNTS:return {ok:true,counts:{total:9000,hidden:0,byPeriod:{1:9000,7:9000}}};
          default:return {ok:true};
        }
      }},
    storage:{local:{get:async()=>({}),set:async()=>{}},onChanged:{addListener:()=>{}}}
  };
  globalThis.shortViewBench={uploads:async()=>({videos:[],avatarUrl:null})};
  await db.reconcileChannels([channel]);
  await db.upsertVideos(Array.from({length:9000},(_,i)=>({id:i===0?normalId:String(i).padStart(11,'v'),channelId,
    title:'Video '+i,publishedAt:Date.now()-i*1000,durationSec:i===4?null:(i===0?12:300),
    thumbUrl:i===0?'https://i.ytimg.com/vi/ordinary001/expired.jpg':
      i===2?'https://i.ytimg.com/vi/vvvvvvvvvv2/cors.jpg':undefined})));
  const cursorStart = performance.now();
  const cursorCount = await db.withTx('videos','readonly',tx=>new Promise((resolve,reject)=>{
    let count=0;
    const request=tx.objectStore('videos').index('by_visible').openCursor(IDBKeyRange.bound([0,Date.now()-30*86400e3],[0,Date.now()]));
    request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{if(!request.result)return resolve(count);count++;request.result.continue();};
  }));
  const cursorMs=performance.now()-cursorStart;
  const bulkStart=performance.now(), pulse=await db.getFeedPulse();
  const bulkMs=performance.now()-bulkStart;
  check('Publications par jour sur 9000 lignes : mêmes données avec lecture groupée',
    Object.values(pulse.perDay).reduce((sum,n)=>sum+n,0)===cursorCount,
    {cursorMs:Math.round(cursorMs),bulkMs:Math.round(bulkMs),count:cursorCount});
  const view=await import('../src/content/feed-view.js');
  try {
    const started=performance.now();
    await view.mountFeedView();
    const elapsed=performance.now()-started;
    const cards=()=>document.querySelectorAll('.tracktube-card');
    // Escapes keep the expected characters independent of source-file encoding.
    for (const [selector, expected] of [
      ['.tracktube-search-icon', '\u2315'],
      ['.tracktube-refresh-glyph', '\u27f3'],
      ['#tracktube-columns button', '\u2212'],
      ['.tracktube-menu-btn', '\u22ee'],
      ['.tracktube-hide', '\u2715'],
      ['.tracktube-star', '\u2605'],
    ]) {
      const actual = document.querySelector(selector)?.textContent;
      check('Symbole affiché intact : ' + selector, actual === expected, actual);
    }
    check('Aucun texte corrompu dans la grille',
      !/[\u00c2\u00c3\ufffd]|\u00e2[\u0080-\u00bf\u0152\u0153\u0178\u02dc\u20ac\u2039\u203a]/u
        .test(document.querySelector('#tracktube-root').textContent));
    check('La vraie grille affiche immédiatement 60 vidéos déjà complètes parmi 9000',cards().length>=60&&elapsed<1000,{cards:cards().length,elapsed:Math.round(elapsed)});
    check('La vidéo ordinaire de 12 secondes est visible',Boolean(document.querySelector(`[data-video-id="${normalId}"]`)));
    check('Une vidéo ordinaire sans durée reste hors de la grille',
      !document.querySelector('[data-video-id="vvvvvvvvvv4"]'));
    await new Promise(r=>setTimeout(r,500));
    const thumbnail = id => document.querySelector(`[data-video-id="${id}"] .tracktube-thumb img`);
    const recovered = thumbnail(normalId);
    check('Une miniature périmée est remplacée par une image réellement chargée',
      recovered?.naturalWidth > 0 && recovered.currentSrc.endsWith('/hqdefault.jpg'));
    const cors = thumbnail('vvvvvvvvvv2');
    check('Une miniature sans autorisation CORS se charge sans CORS',
      cors?.naturalWidth > 0 && !cors.hasAttribute('crossorigin'),
      {width:cors?.naturalWidth,src:cors?.currentSrc,crossorigin:cors?.getAttribute('crossorigin')});
    const below = thumbnail('vvvvvvvvv59');
    check('Les miniatures de la page sont chargées avant le défilement', below?.naturalWidth > 0);
    const failedRequests = performance.getEntriesByType('resource')
      .filter(entry => entry.name.includes('/vvvvvvvvvv3/')).length;
    check('Une miniature indisponible ne boucle pas et ne masque pas la vidéo',
      failedRequests > 0 && failedRequests <= 2 && Boolean(thumbnail('vvvvvvvvvv3')),
      {failedRequests});
    check('Un contrôle de chaîne en attente ne cache aucune carte',screenCalls>0&&[...cards()].every(c=>getComputedStyle(c).display!=='none'));
    check('La grille ne parcourt pas les 9000 vidéos pour chercher une carte autorisée',pageCalls<=2,pageCalls);
    const gone='vvvvvvvvvv1';
    await db.recordVideoClassification(gone,true,Date.now());
    for(const listener of listeners) listener({type:MSG.VIDEOS_GONE,ids:[gone]});
    await new Promise(r=>setTimeout(r,200));
    check('Un Short identifié quitte la grille et ne peut pas être recréé par enrichissement',
      !document.querySelector(`[data-video-id="${gone}"]`)&&!(await verifiedFeedVideos([gone])).length);
    const beforeRefresh = pageCalls;
    const middle = Number(cards()[30].dataset.publishedAt) + 1;
    const lateId = 'Xts1bF46nt4';
    const additions = Array.from({length:125},(_,i)=>({
      id:String(i).padStart(11,'n'),channelId,title:'Nouvelle '+i,publishedAt:Date.now()+i,
      durationSec:300,
    }));
    additions.push({id:lateId,channelId,title:'Découverte tardive',publishedAt:middle,durationSec:300});
    await db.upsertVideos(additions);
    const refresh = document.querySelector('#tracktube-refresh');
    refresh.click();
    for(let i=0;i<100&&refresh.disabled;i++) await new Promise(r=>setTimeout(r,20));
    check('Actualiser récupère plus de 60 nouveautés et une découverte au milieu de la grille',
      !refresh.disabled && additions.every(v=>document.querySelector(`[data-video-id="${v.id}"]`)));
    check('Le rattrapage relit seulement la plage parcourue, pas les 9000 lignes',
      pageCalls-beforeRefresh<=5,{pages:pageCalls-beforeRefresh});
    const ordered = [...cards()].map(c=>Number(c.dataset.publishedAt));
    check('Le rattrapage conserve l’ordre chronologique et les cartes existantes',
      ordered.every((date,i)=>!i||date<=ordered[i-1]) && Boolean(thumbnail(normalId)));
    refresh.click();
    for(let i=0;i<100&&refresh.disabled;i++) await new Promise(r=>setTimeout(r,20));
    check('Deux actualisations ne dupliquent aucune carte',
      new Set([...cards()].map(c=>c.dataset.videoId)).size===cards().length);
  } finally {view.unmountFeedView();release();}
  return results;
}
