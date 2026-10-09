import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

/** Local fixtures need real HTTP byte ranges to test media seeking. */
export function createBenchServer(root) {
  const retries=new Map();
  return createServer(async (req, res) => {
    const url=new URL(req.url,'http://127.0.0.1');
    const path=resolve(root,'.'+decodeURIComponent(url.pathname));
    if(!path.startsWith(root+sep)){res.writeHead(403).end();return;}
    try {
      const body=await readFile(path);
      const headers={ 'Content-Type': ({'.js':'text/javascript','.mjs':'text/javascript',
        '.html':'text/html','.css':'text/css','.svg':'image/svg+xml','.mp4':'video/mp4'})[extname(path)]||'application/octet-stream',
        'Cache-Control':'no-store','Accept-Ranges':'bytes' };
      const queryRange=url.searchParams.get('range');
      const range=/^bytes=(\d+)-(\d*)$/.exec(queryRange?`bytes=${queryRange}`:(req.headers.range||''));
      if(range){
        const start=Number(range[1]),end=Math.min(range[2]?Number(range[2]):body.length-1,body.length-1);
        const example=url.searchParams.get('case');
        if(example==='slow-header'&&start===0)await new Promise(r=>setTimeout(r,1800));
        if(example==='slow-segment'&&start>0)await new Promise(r=>setTimeout(r,350));
        if(example==='audio-segment-refused'&&path.endsWith('preview-audio.mp4')&&start>0){res.writeHead(403).end();return;}
        if(path.endsWith('preview-audio.mp4')&&start===0){
          if(example==='audio-alternative'){res.writeHead(403).end();return;}
          if(example==='audio-refused'){res.writeHead(503).end();return;}
          if(example==='audio-retry'){
            const count=(retries.get(example)||0)+1;retries.set(example,count);
            if(count<=2){res.writeHead(503).end();return;}
          }
        }
        if(example==='seek-refused'&&url.searchParams.has('cap')&&start>=Number(url.searchParams.get('cap'))){res.writeHead(403).end();return;}
        if(start>end){res.writeHead(416,{'Content-Range':`bytes */${body.length}`}).end();return;}
        res.writeHead(206,{...headers,'Content-Range':`bytes ${start}-${end}/${body.length}`,
          'Content-Length':end-start+1}).end(body.subarray(start,end+1));
      }else res.writeHead(200,{...headers,'Content-Length':body.length}).end(body);
    }catch{res.writeHead(404).end();}
  });
}
