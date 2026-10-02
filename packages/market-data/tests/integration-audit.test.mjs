import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {marketFromRows,sessionUtc} from '../../../apps/dashboard/src/market-bridge.mjs';
import {gammaProfile,newsRoutes} from '../../../apps/dashboard/src/analytics.mjs';
import {writeArchive,readArchive} from '../src/archive.mjs';
import {result,sha256} from '../src/common.mjs';
const bar=(symbol,timestamp,interval='1m',provider='test')=>({symbol,timestamp,timestampKind:'bar-open',interval,open:5000,high:5001,low:4999,close:5000,volume:100,source:{provider,mode:'synthetic'}});
const quote=(strike,timestamp,root='SPXW',extra={})=>({symbol:root,root,expiration:'2026-10-01',right:'CALL',strike,bid:1,ask:1.2,timestamp,gamma:.01,openInterest:100,openInterestTimestamp:'2026-10-01T10:30:00Z',...extra});
const bars=[bar('SPX','2026-10-01T13:30:00Z'),bar('SPY','2026-10-01T13:30:00Z')];

test('audit: asynchronous same-expiry chain keeps coherent contracts and excludes foreign roots',()=>{
 const p=marketFromRows({date:'2026-10-01',cutoff:570,rows:bars,quoteCutoffIso:'2026-10-01T13:31:20Z',strictReplay:true,options:[quote(5000,'2026-10-01T13:31:05Z'),quote(5005,'2026-10-01T13:31:10Z'),quote(5010,'2026-10-01T13:31:10Z','SPY')]});
 assert.equal(p.chain.length,2);assert(p.chain.every(q=>q.root==='SPXW'));assert.equal(p.chainCoverage.coherentContracts,2);assert.equal(p.data.quotes.length,0); // live quote is not a completed-bar premium-history point
});
test('audit: minute engine rejects incomplete off-grid bars, other intervals and mixed providers',()=>{
 let p=marketFromRows({date:'2026-10-01',cutoff:570,rows:[...bars,bar('SPX','2026-10-01T13:30:30Z'),bar('SPX','2026-10-01T13:30:00Z','5m')]});assert.equal(p.data.spx.length,1);
 p=marketFromRows({date:'2026-10-01',cutoff:570,rows:[...bars,bar('SPX','2026-10-01T13:30:00Z','1m','other')]});assert.equal(p.data.spx.length,0);assert.match(p.warnings.join(' '),/providers/i);
});
test('audit: gamma refuses independently future Greeks and invalid OI timestamps',()=>{
 const cutoff='2026-10-01T13:31:00Z';
 assert.equal(gammaProfile([quote(5000,'2026-10-01T13:30:00Z','SPXW',{greeksTimestamp:'2026-10-01T13:32:00Z',openInterestAsOf:'2026-10-01T10:30:00Z'})],5000,cutoff).rows.length,0);
 assert.equal(gammaProfile([quote(5000,'2026-10-01T13:30:00Z','SPXW',{openInterestTimestamp:'invalid',openInterestAsOf:'invalid'})],5000,cutoff).rows.length,0);
});
test('audit: downloader option-history schema replays through exact contract bridge',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'spx-cross-audit-'));
 try {
  await writeArchive({directory,query:{kind:'option-history',symbol:'SPXW',start:'2026-10-01',end:'2026-10-01',expiration:'2026-10-01',strike:5000,right:'CALL'},envelope:result('audit-fixture',[quote(5000,'2026-10-01T13:30:10Z'),quote(5000,'2026-10-01T13:31:10Z')],{mode:'synthetic'})});
  const archive=await readArchive({directory,kind:'option-history',start:'2026-10-01',end:'2026-10-01',asOf:sessionUtc('2026-10-01',570,true)});
  assert.equal(archive.rows.length,1);
  const p=marketFromRows({date:'2026-10-01',cutoff:570,rows:bars,options:archive.rows,strictReplay:true});assert.equal(p.chain.length,1);assert.equal(p.chain[0].openInterest,100);assert.equal(p.chain[0].openInterestAsOf,'2026-10-01T10:30:00Z');
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('audit: archive refuses symlink escape even when hash and row count match',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'spx-path-audit-')),outside=await mkdtemp(join(tmpdir(),'spx-path-outside-'));
 try {const text=JSON.stringify(bars[0])+'\n';await writeFile(join(outside,'private.ndjson'),text);await symlink(join(outside,'private.ndjson'),join(directory,'escape.ndjson'));await writeFile(join(directory,'manifest.json'),JSON.stringify({schemaVersion:1,entries:[{file:'escape.ndjson',status:'complete',kind:'bars',symbol:'SPX',rowCount:1,sha256:sha256(text)}]}));await assert.rejects(()=>readArchive({directory,kind:'bars'}),/escapes/);}finally{await rm(directory,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
test('audit: article first-seen and publication both precede news cutoff',()=>{
 const row={title:'Nvidia AI investment',timestamp:'2026-10-01T14:00:00Z',publishedAt:'2026-10-01T14:00:00Z',firstSeenAt:'2026-10-01T14:15:00Z'};
 assert.equal(newsRoutes([row],'2026-10-01T14:10:00Z').length,0);const available=newsRoutes([row],'2026-10-01T14:20:00Z');assert.equal(available.length,1);assert.equal(available[0].forecastInfluence,false);
});
