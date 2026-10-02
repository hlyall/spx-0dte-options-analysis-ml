import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseYahoo,parseStooq,parseFred,parseRss} from '../src/providers/free.mjs';
import {parseThetaOptions,thetaRows,thetaProvider} from '../src/providers/theta.mjs';
import {tradierProvider} from '../src/providers/tradier.mjs';
import {easternToUtc,iso,result,cleanBars,safeError} from '../src/common.mjs';
import {createMarketDataClient,loadConfig,writeArchive,readArchive,verifyArchive} from '../src/index.mjs';
import {createHttp} from '../src/http.mjs';
import {planJobs,parseArgs,main} from '../../../tools/downloader/cli.mjs';
const bar={symbol:'SPX',timestamp:'2026-09-30T13:30:00.000Z',timestampKind:'bar-open',interval:'5m',open:5000,high:5002,low:4998,close:5001,volume:null};

test('Tradier production index observations retain the documented 15-minute delay',async()=>{
  // Invented responses test source labels, not provider availability or prices.
  const stamp=Date.parse('2035-05-17T14:00:00Z');
  const http={json:async url=>String(url).includes('quotes')
    ? {quotes:{quote:{last:5000,trade_date:stamp,type:'index'}}}
    : {series:{data:[{timestamp:stamp/1000,open:5000,high:5001,low:4999,close:5000,volume:0}]}}};
  const provider=tradierProvider(http,{sandbox:false},'invented-test-token');
  for(const symbol of ['SPX','XSP','VIX','TNX','NDX','RUT']){
    const quote=await provider.quote({symbol});
    const bars=await provider.bars({symbol,start:'2035-05-17',end:'2035-05-17',interval:'1m'});
    for(const response of [quote,bars]){
      assert.equal(response.source.mode,'delayed');
      assert.equal(response.source.delaySeconds,900);
      assert.equal(response.source.asOf,'2035-05-17T14:00:00.000Z');
    }
  }
  const identified=await provider.quote({symbol:'INVENTEDINDEX'});
  assert.equal(identified.source.delaySeconds,900);
});

test('Tradier production equities and option quotes do not inherit index delay',async()=>{
  const stamp=Date.parse('2035-05-17T14:00:00Z');
  const http={json:async url=>String(url).includes('chains')
    ? {options:{option:{symbol:'SPXW350517C05000000',root_symbol:'SPXW',expiration_date:'2035-05-17',strike:5000,option_type:'call',bid:1,ask:1.1,bid_date:stamp,ask_date:stamp}}}
    : String(url).includes('quotes') ? {quotes:{quote:{last:500,trade_date:stamp,type:'etf'}}}
    : {series:{data:[{timestamp:stamp/1000,open:500,high:501,low:499,close:500,volume:100}]}}};
  const provider=tradierProvider(http,{sandbox:false},'invented-test-token');
  for(const response of [await provider.quote({symbol:'SPY'}),await provider.bars({symbol:'SPY',start:'2035-05-17',end:'2035-05-17',interval:'1m'}),await provider.options({symbol:'SPXW',expiration:'2035-05-17'})]){
    assert.notEqual(response.status,'unavailable');
    assert.equal(response.source.mode,'realtime');
    assert.equal(response.source.delaySeconds,0);
  }
});

test('Tradier daily index bars remain daily and sandbox index requests stay unavailable',async()=>{
  const http={json:async()=>({history:{day:{date:'2035-05-17',open:5000,high:5001,low:4999,close:5000,volume:0}}})};
  const daily=await tradierProvider(http,{sandbox:false},'invented-test-token').bars({symbol:'SPX',start:'2035-05-17',end:'2035-05-17',interval:'1d'});
  assert.equal(daily.source.mode,'daily');assert.equal(daily.source.delaySeconds,900);
  const sandbox=tradierProvider({json:async()=>assert.fail('Sandbox index must not request data')},{sandbox:true},'invented-test-token');
  assert.equal((await sandbox.quote({symbol:'SPX'})).status,'unavailable');
  assert.equal((await sandbox.bars({symbol:'SPX',start:'2035-05-17',end:'2035-05-17'})).status,'unavailable');
});

test('provider configuration is credential-free and loads from any working directory',async()=>{const cfg=await loadConfig({env:{}});assert.equal(cfg.providers.theta.enabled,false);assert.equal(cfg.providers.yahoo.enabled,true);assert.equal(cfg.providers.tradier.enabled,false);});
test('timestamps convert New York summer and winter and preserve explicit offsets',()=>{assert.equal(easternToUtc('2026-09-30T09:30:00.000'),'2026-09-30T13:30:00.000Z');assert.equal(easternToUtc('2026-01-15T09:30:00.123'),'2026-01-15T14:30:00.123Z');assert.equal(easternToUtc('2026-01-15T09:30:00-05:00'),'2026-01-15T14:30:00.000Z');assert.equal(iso(null),null);});
test('Yahoo null OHLC is absent rather than zero, volume remains absent for an index',()=>{const parsed=parseYahoo({chart:{result:[{meta:{},timestamp:[1790775000,1790775300],indicators:{quote:[{open:[5000,null],high:[5002,null],low:[4998,null],close:[5001,null]}]}}]}},'SPX','5m');assert.equal(parsed.rows.length,1);assert.equal(parsed.rejected,1);assert.equal(parsed.rows[0].volume,null);});
test('Stooq dates remain session-date markers and schema HTML rejected',()=>{const parsed=parseStooq('Date,Open,High,Low,Close,Volume\n2026-09-30,5000,5002,4998,5001,0\n','SPX');assert.equal(parsed.rows[0].timestampKind,'session-date');assert.throws(()=>parseStooq('<html>blocked</html>','SPX'));});
test('FRED missing values are omitted, never imputed as zero',()=>{const rows=parseFred('observation_date,DGS10\n2026-09-29,.\n2026-09-30,4.23\n');assert.equal(rows.length,1);assert.equal(rows[0].value,4.23);assert.equal(rows[0].timestampKind,'observation-date');});
test('RSS HTML is plain text and links constrained to official publisher',()=>{const rows=parseRss('<rss><item><title><![CDATA[Policy &amp; rates]]></title><link>https://www.federalreserve.gov/newsevents/x.htm</link><pubDate>Wed, 30 Sep 2026 14:00:00 GMT</pubDate></item><item><title>bad</title><link>javascript:alert(1)</link><pubDate>Wed, 30 Sep 2026 14:00:00 GMT</pubDate></item></rss>');assert.equal(rows.length,1);assert.equal(rows[0].title,'Policy & rates');});
test('Theta grouped responses normalize contract identity, reject crossed quotes and preserve null Greeks',()=>{const raw={response:[{contract:{symbol:'SPXW',expiration:'2026-09-30',strike:5000,right:'CALL'},data:[{bid:2,ask:2.2,timestamp:'2026-09-30T10:00:00.000'},{bid:3,ask:2,timestamp:'2026-09-30T10:01:00.000'}]}]};const parsed=parseThetaOptions(thetaRows(raw));assert.equal(parsed.rows.length,1);assert.equal(parsed.rejected,1);assert.equal(parsed.rows[0].gamma,null);assert.equal(parsed.rows[0].timestamp,'2026-09-30T14:00:00.000Z');});
test('conflicting duplicate bars fail validation rather than overwrite',()=>{assert.throws(()=>cleanBars([bar,{...bar,close:5000}]),/Conflicting/);});
test('Theta pagination refuses foreign origin',async()=>{const adapter=thetaProvider({request:async()=>({text:JSON.stringify({response:[]}),headers:new Headers({'next-page':'https://evil.example/history/'})})});await assert.rejects(()=>adapter.bars({symbol:'SPX',start:'2026-09-30',end:'2026-09-30'}),/Unsafe/);});
test('explicit provider selection never falls back to another source',async()=>{const client=await createMarketDataClient({config:{providers:{yahoo:{enabled:false},stooq:{enabled:false},fed:{enabled:false},fred:{enabled:false},theta:{enabled:false},tradier:{enabled:false}},priority:{quote:['yahoo']}},fetchImpl:async()=>{throw new Error('should not fetch');}});const value=await client.quote({symbol:'SPX',provider:'stooq'});assert.equal(value.status,'unavailable');assert.deepEqual(value.attempts,[{provider:'stooq',reason:'Provider is not enabled'}]);});
test('network failures do not expose URL secrets or become synthetic successes',async()=>{assert.equal(safeError(new Error('https://a.test?token=TOPSECRET')),'Provider data unavailable or failed validation');const cfg=await loadConfig({env:{}});cfg.retries=0;cfg.minimumRequestIntervalMs=0;const client=await createMarketDataClient({config:cfg,env:{},fetchImpl:async()=>{throw new Error('fetch failed SECRET');}});const value=await client.bars({symbol:'SPX',start:'2026-09-30',end:'2026-09-30',interval:'5m'});assert.equal(value.status,'unavailable');assert.equal(value.data,null);assert(!JSON.stringify(value).includes('SECRET'));});
test('HTTP retry honors bounded retry-after and does not retry authorization failures',async()=>{let calls=0;const http=createHttp({minimumRequestIntervalMs:0,retries:1,fetchImpl:async()=>{calls++;return calls===1?new Response('',{status:429,headers:{'retry-after':'0'}}):new Response('{"ok":true}');}});assert.deepEqual(await http.json('https://example.com/'),{ok:true});assert.equal(calls,2);calls=0;const auth=createHttp({minimumRequestIntervalMs:0,retries:1,fetchImpl:async()=>{calls++;return new Response('',{status:401});}});await assert.rejects(()=>auth.json('https://example.com/'),/HTTP 401/);assert.equal(calls,1);});
test('archive verifies checksums and respects completed-bar cutoff and source mode',async()=>{const directory=await mkdtemp(join(tmpdir(),'spx-test-'));try {const entry=await writeArchive({directory,query:{kind:'bars',symbol:'SPX',start:'2026-09-30',end:'2026-09-30',interval:'5m'},envelope:result('fixture',[bar],{mode:'synthetic'})});assert(await verifyArchive({directory,entry}));assert.equal((await readArchive({directory,symbol:'SPX',asOf:'2026-09-30T13:34:59Z'})).rows.length,0);assert.equal((await readArchive({directory,symbol:'SPX',asOf:'2026-09-30T13:35:00Z'})).rows.length,1);await writeFile(join(directory,entry.file),'corrupt');assert.equal(await verifyArchive({directory,entry}),false);await assert.rejects(()=>readArchive({directory}),/checksum/);}finally{await rm(directory,{recursive:true,force:true});}});
test('archive blocks traversal even when checksum matches',async()=>{const directory=await mkdtemp(join(tmpdir(),'spx-test-'));try {await writeFile(join(directory,'manifest.json'),JSON.stringify({schemaVersion:1,entries:[{file:'../other',kind:'bars',status:'complete'}]}));await assert.rejects(()=>readArchive({directory}));}finally{await rm(directory,{recursive:true,force:true});}});
test('downloader rejects fake historical snapshots, dates and oversized requests',()=>{assert.throws(()=>planJobs({kind:'options',date:'2026-09-29',expiration:'2026-09-30'},'2026-09-30'),/backdated/);assert.throws(()=>planJobs({date:'2026-02-30'},'2026-09-30'),/valid/);assert.throws(()=>planJobs({start:'2026-01-01',end:'2026-09-30'},'2026-09-30'),/max-days/);assert.throws(()=>parseArgs(['--token','SECRET']),/Unknown/);});
test('downloader resume avoids duplicate provider calls after checksum validation',async()=>{const directory=await mkdtemp(join(tmpdir(),'spx-test-'));let calls=0;const client={bars:async()=>{calls++;return result('fixture',[bar],{mode:'synthetic'});}};try {const args=['--kind','bars','--symbol','SPX','--date','2026-09-30','--out',directory];assert.equal(await main(args,{client}),0);assert.equal(await main(args,{client}),0);assert.equal(calls,1);}finally{await rm(directory,{recursive:true,force:true});}});
test('Theta coherent quote/Greek snapshots join only earlier OI; stale underlying Greeks withheld',async()=>{const mk=(time,underlying)=>({symbol:'SPXW',expiration:'2026-09-30',strike:5000,right:'CALL',timestamp:time,underlying_timestamp:underlying,underlying_price:5000,bid:2,ask:2.2,gamma:.01,delta:.5,theta:-1,vega:2,implied_vol:.15});let underlying='2026-09-30T10:00:00.000';let oiTime='2026-09-30T06:30:00.000';const http={request:async url=>({headers:new Headers(),text:JSON.stringify({response:String(url).includes('open_interest')?[{...mk(oiTime,underlying),open_interest:123}]:[mk('2026-09-30T10:00:01.000',underlying)]})})};let response=await thetaProvider(http).options({expiration:'2026-09-30',strike:5000});assert.equal(response.data[0].gamma,.01);assert.equal(response.data[0].openInterest,123);assert.equal(response.data[0].openInterestSessionDate,null);underlying='2026-09-30T09:58:00.000';oiTime='2026-09-30T10:01:00.000';response=await thetaProvider(http).options({expiration:'2026-09-30',strike:5000});assert.equal(response.data[0].gamma,null);assert.equal(response.data[0].openInterest,null);assert.equal(response.data[0].greeksQuality,'underlying-stale-or-untimestamped');});
test('archive replay excludes news first seen after cutoff and un-timed daily observations',async()=>{const directory=await mkdtemp(join(tmpdir(),'spx-test-'));try {await writeArchive({directory,query:{kind:'news',start:'2026-09-30'},envelope:result('fixture',[{title:'sample',timestamp:'2026-09-30T14:00:00Z',firstSeenAt:'2026-09-30T15:00:00Z'}],{mode:'synthetic'})});assert.equal((await readArchive({directory,kind:'news',asOf:'2026-09-30T14:30:00Z'})).rows.length,0);await writeArchive({directory,query:{kind:'bars',symbol:'SPX',start:'2026-09-30',interval:'1d'},envelope:result('fixture',[{...bar,interval:'1d',timestampKind:'session-date',timestamp:'2026-09-30T00:00:00Z'}],{mode:'daily'})});assert.equal((await readArchive({directory,asOf:'2026-09-30T19:00:00Z'})).rows.length,0);}finally{await rm(directory,{recursive:true,force:true});}});
test('Theta vega is normalized per volatility percentage point with explicit remaining units',()=>{const row={symbol:'SPXW',expiration:'2026-09-30',strike:5000,right:'CALL',bid:2,ask:2.2,timestamp:'2026-09-30T10:00:00.000',vega:142,theta:-12};const parsed=parseThetaOptions([row]).rows[0];assert.equal(parsed.vega,1.42);assert.equal(parsed.theta,-12);assert.equal(parsed.greeksUnits.theta,'provider-reported');});
test('Theta impossible or ambiguous Eastern wall clocks are not silently guessed',()=>{assert.equal(easternToUtc('2026-02-30T10:00:00'),null);assert.equal(easternToUtc('2026-03-08T02:30:00'),null);assert.equal(easternToUtc('2026-11-01T01:30:00'),null);assert.equal(easternToUtc('2026-09-30T25:00:00'),null);});
test('archive replay withholds later Greeks, OI and underlying marks and rejects future bid/ask side',async()=>{const directory=await mkdtemp(join(tmpdir(),'spx-test-'));try {const row={symbol:'SPXW',expiration:'2026-09-30',right:'CALL',strike:5000,timestamp:'2026-09-30T14:00:00Z',bid:1,ask:2,gamma:.01,delta:.5,theta:-1,vega:1,iv:.2,greeksTimestamp:'2026-09-30T14:10:00Z',openInterest:100,openInterestTimestamp:'2026-09-30T14:10:00Z',underlyingPrice:5000,underlyingTimestamp:'2026-09-30T14:10:00Z'};await writeArchive({directory,query:{kind:'options',symbol:'SPXW',start:'2026-09-30'},envelope:result('fixture',[row,{...row,strike:5005,askTimestamp:'2026-09-30T14:06:00Z'}],{mode:'synthetic'})});const read=await readArchive({directory,kind:'options',asOf:'2026-09-30T14:05:00Z'});assert.equal(read.rows.length,1);assert.equal(read.rows[0].gamma,null);assert.equal(read.rows[0].openInterest,null);assert.equal(read.rows[0].underlyingPrice,null);}finally{await rm(directory,{recursive:true,force:true});}});
test('normalized minute bars reject off-grid snapshots masquerading as completed bars',()=>{const clean=cleanBars([bar,{...bar,timestamp:'2026-09-30T13:30:30.000Z'},{...bar,timestamp:'2026-09-30T13:31:00.050Z'}]);assert.equal(clean.rows.length,1);assert.equal(clean.rejected,2);});
test('Yahoo adapter rejects a response for a different instrument',async()=>{const cfg=await loadConfig({env:{}});cfg.minimumRequestIntervalMs=0;cfg.retries=0;const client=await createMarketDataClient({config:cfg,env:{},fetchImpl:async()=>new Response(JSON.stringify({chart:{result:[{meta:{symbol:'AAPL',regularMarketPrice:200,regularMarketTime:1790775000},timestamp:[1790775000],indicators:{quote:[{open:[200],high:[201],low:[199],close:[200],volume:[100]}]}}]}}))});const q=await client.quote({symbol:'SPX',provider:'yahoo'});assert.equal(q.status,'unavailable');assert.equal(q.data,null);});
