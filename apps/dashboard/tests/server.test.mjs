import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeArchive} from '../../../packages/market-data/src/archive.mjs';

test('isolated read-only server serves demo, bounded archive replay and security headers',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'spx-dashboard-test-'));let child;
 try{
 const source={provider:'synthetic-fixture',mode:'synthetic',asOf:'2026-10-01T15:00:00.000Z',retrievedAt:'2026-10-01T15:00:00.000Z'};
 for(const symbol of ['SPX','SPY'])await writeArchive({directory:dir,query:{kind:'bars',symbol,start:'2026-10-01',end:'2026-10-01',interval:'1m'},envelope:{status:'ok',source,warnings:[],data:Array.from({length:4},(_,i)=>({symbol,timestamp:`2026-10-01T13:${30+i}:00.000Z`,timestampKind:'bar-open',interval:'1m',open:100,high:101,low:99,close:100+i/10,volume:10}))}});
 child=spawn(process.execPath,[fileURLToPath(new URL('../src/server.mjs',import.meta.url))],{env:{...process.env,PORT:'0',HOST:'127.0.0.1',SPX_ARCHIVE_DIR:dir},stdio:['ignore','pipe','pipe']});
 const address=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(new Error('Server startup timed out')),10000);child.stdout.on('data',chunk=>{text+=chunk.toString();const m=/http:\/\/127\.0\.0\.1:(\d+)/.exec(text);if(m){clearTimeout(timer);resolve(m[0]);}});child.once('error',reject);child.once('exit',code=>reject(new Error(`Server exited ${code}`)));});
 const root=await fetch(address);assert.equal(root.status,200);assert.match(root.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.match(await root.text(),/SPX.*MACHINE INTELLIGENCE/);
 const demo=await (await fetch(address+'/api/snapshot?mode=demo&cutoff=650')).json();assert.equal(demo.mode,'synthetic');assert.equal(demo.data.spx.at(-1).timestamp,'2026-10-01T10:50:00.000');assert.equal(demo.chain.length,62);
 const replay=await (await fetch(address+'/api/snapshot?mode=replay&date=2026-10-01&cutoff=571')).json();assert.equal(replay.mode,'replay');assert.equal(replay.data.spx.length,2);assert.equal(replay.data.spx.at(-1).timestamp,'2026-10-01T09:31:00.000');
 assert.equal((await fetch(address+'/api/snapshot',{method:'POST'})).status,405);assert.equal((await fetch(address+'/.env')).status,404);
 }finally{child?.kill('SIGTERM');await rm(dir,{recursive:true,force:true});}
});
