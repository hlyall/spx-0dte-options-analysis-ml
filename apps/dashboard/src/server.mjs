import http from 'node:http';
import { readFile, access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoMarket, DEMO_DATE } from './demo.mjs';
import { analyze, gammaProfile, riskProfile, localTimestamp, minuteOf, SECTORS } from './analytics.mjs';
import { marketFromRows, sessionUtc } from './market-bridge.mjs';
import {loadSession} from './calendar.mjs';

const appRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..'),root=resolve(appRoot,'../..');
const port=Number(process.env.PORT||8787),host=process.env.HOST||'127.0.0.1';
const archiveDir=resolve(root,process.env.SPX_ARCHIVE_DIR||'data/downloads'),modelDir=resolve(root,process.env.SPX_MODEL_DIR||'models');
let clientPromise,onlineCache,pendingOnline;
const getLibrary=()=>import('../../../packages/market-data/src/index.mjs');
async function getClient(){if(!clientPromise)clientPromise=getLibrary().then(m=>m.createMarketDataClient(process.env.SPX_CONFIG?{configPath:resolve(root,process.env.SPX_CONFIG)}:{}));return clientPromise;}
async function models(){const out={};for(const [key,file]of [['sponge','sponge-model.json'],['missing','sponge-missing-model.json'],['interactions','sponge-interactions-model.json']])try{const raw=await readFile(resolve(modelDir,file),'utf8');if(raw.length>25_000_000)throw new Error('Model file exceeds25MB');out[key]=JSON.parse(raw);}catch(e){if(e.code!=='ENOENT')out.loadError=`Model ${file} could not be read`; }return out;}
const safeError=e=>String(e?.message||'Unavailable').replace(/(token|key|authorization)([=: ]+)\S+/ig,'$1$2[redacted]');
async function online(){if(onlineCache&&Date.now()-onlineCache.at<60_000)return onlineCache.value;if(pendingOnline)return pendingOnline;
 pendingOnline=(async()=>{const client=await getClient(),now=new Date(),today=localTimestamp(now.toISOString()).slice(0,10),start=new Date(now-7*86400000).toISOString().slice(0,10),symbols=['SPX','SPY',...SECTORS,'USO','TNX'];
 const all=await Promise.all(symbols.map(async symbol=>{try{const bars=await client.bars({symbol,start,end:today,interval:'1m'});return {symbol,bars};}catch(e){return {symbol,bars:{status:'unavailable',data:[],warnings:[safeError(e)],source:{provider:'unavailable',mode:'unknown'}}};}}));
 const [quote,options,news]=await Promise.all([client.quote('SPX'),client.options({symbol:'SPXW',expiration:today}),client.news({limit:12})].map(p=>p.catch(e=>({status:'unavailable',data:[],warnings:[safeError(e)],source:{provider:'unavailable',mode:'unknown'}}))));
 const completedAt=new Date().toISOString();
 const rows=all.flatMap(({symbol,bars})=>(Array.isArray(bars.data)?bars.data:[]).map(r=>({...r,symbol,source:bars.source})));
 const latest=rows.filter(r=>r.symbol==='SPX'&&r.timestampKind!=='session-date').map(r=>localTimestamp(r.timestamp)?.slice(0,10)).filter(Boolean).sort().at(-1)||today;
 const calendar=await loadSession(root,latest);const maxMinute=latest===today?Math.min(calendar.close-1,minuteOf(localTimestamp(completedAt))-1):calendar.close-1;
 const bridged=marketFromRows({date:latest,cutoff:maxMinute,rows,options:Array.isArray(options.data)?options.data:[],quoteCutoffIso:completedAt,sessionClose:calendar.close});
 return {...bridged,mode:'online',label:'PUBLIC / CONFIGURED SOURCES • inspect each source timestamp and delay',news:Array.isArray(news.data)?news.data:[],sources:all.map(x=>({name:x.symbol,...x.bars,data:undefined})),optionSource:{...options,data:undefined},newsSource:{...news,data:undefined},quote,daily:rows.filter(r=>r.timestampKind==='session-date'||r.source?.mode==='daily'),fetchedAt:completedAt,calendar,sessionNote:`Cash calendar: ${calendar.kind}; ${calendar.open}–${calendar.close} ET minute bounds. ${calendar.verified?'Published exchange schedule; emergency changes require a dated override.':'Unverified calendar: forecasts and pattern alerts are held.'}`};
 })();try{const value=await pendingOnline;onlineCache={at:Date.now(),value};return value;}finally{pendingOnline=null;}}
async function replay(date,cutoff){const lib=await getLibrary(),start=new Date(Date.parse(date)-7*86400000).toISOString().slice(0,10);
 const results=await Promise.all(['bars','options','option-history','news'].map(kind=>lib.readArchive({directory:archiveDir,kind,start,end:date,provider:kind==='news'?undefined:process.env.SPX_REPLAY_PROVIDER,interval:kind==='bars'?'1m':undefined,asOf:sessionUtc(date,kind==='bars'?cutoff+1:cutoff,kind!=='bars')})));
 const rows=results.flatMap(a=>a.rows||[]),entries=results.flatMap(a=>a.entries||[]);
 const bars=rows.filter(r=>r.open!==undefined),opts=rows.filter(r=>r.strike!==undefined),news=rows.filter(r=>r.title);
 const calendar=await loadSession(root,date);const modes=new Set(rows.map(r=>r.source?.mode==='synthetic'?'synthetic':'observed'));if(modes.size>1)throw new Error('Synthetic and observed archive data cannot be combined; choose a separate SPX_ARCHIVE_DIR or SPX_REPLAY_PROVIDER.');const synthetic=modes.has('synthetic');
 const bridged=marketFromRows({date,cutoff,rows:bars,options:opts,mode:'historical',strictReplay:true,sessionClose:calendar.close});
 return {...bridged,mode:'replay',news,label:synthetic?'SYNTHETIC ARCHIVE REPLAY • invented data • no trading use':'HISTORICAL REPLAY • observations only through selected cutoff',synthetic,calendar,sources:entries,sessionNote:`Cash calendar: ${calendar.kind}. OI without a known as-of time is withheld. Unverified calendars hold forecasts and pattern alerts.`};}

function liveInputsCurrent(payload){
 const now=Date.now(),today=localTimestamp(new Date(now).toISOString()).slice(0,10);if(payload.data.date!==today)return false;
 for(const symbol of ['SPX','SPY',...SECTORS,'USO','TNX']){const s=payload.sources.find(s=>s.name===symbol),bars=symbol==='SPX'?payload.data.spx:symbol==='SPY'?payload.data.spy:payload.data.context.find(c=>c.symbol===symbol)?.bars;const last=bars?.at(-1);if(!last||!s||s.status==='unavailable')return false;
  const permitted=s.source?.provider==='theta'||s.source?.mode==='realtime';const end=Date.parse(sessionUtc(today,minuteOf(last.timestamp)+1));if(!permitted||now-end>120000||end>now)return false;}
 return true;
}
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://127.0.0.1');const requestHost=(req.headers.host||'').split(':')[0];const allowedHosts=new Set(['127.0.0.1','localhost',host]);if(!allowedHosts.has(requestHost)){json(res,403,{error:'Unrecognized Host'});return;}if(req.headers.origin){const origin=new URL(req.headers.origin);if(!allowedHosts.has(origin.hostname)||Number(origin.port||80)!==server.address()?.port){json(res,403,{error:'Unrecognized Origin'});return;}}
 if(req.method!=='GET'){json(res,405,{error:'Read-only server; GET required'});return;}
 if(url.pathname==='/api/health'){json(res,200,{status:'ok',name:'SPX Machine Intelligence',port:server.address()?.port,readOnly:true,version:'0.1.0'});return;}
 if(url.pathname==='/api/providers'){const client=await getClient();json(res,200,await client.providers());return;}
 if(url.pathname==='/api/archives'){const lib=await getLibrary();try{json(res,200,await lib.listArchive({directory:archiveDir}));}catch(e){json(res,200,{entries:[],warnings:[safeError(e)]});}return;}
 if(url.pathname==='/api/risk'){const legs=JSON.parse(url.searchParams.get('legs')||'[]');json(res,200,{points:riskProfile(legs,Number(url.searchParams.get('spot')),Number(url.searchParams.get('range')||80))});return;}
 if(url.pathname==='/api/snapshot'){const mode=url.searchParams.get('mode')||'online',cutoff=Number(url.searchParams.get('cutoff')||719),date=url.searchParams.get('date')||DEMO_DATE;
 if(!['online','demo','replay'].includes(mode)||!Number.isInteger(cutoff)||cutoff<0||cutoff>1439||!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error('Invalid view parameters');
 const payload=mode==='demo'?demoMarket(cutoff):mode==='replay'?await replay(date,cutoff):await online();
 const bundle=mode==='demo'?{}:await models();const analysis=analyze(payload.data,{cutoff:payload.data.asOf,models:bundle,news:payload.news,cutoffIso:payload.cutoffIso,newsCutoffIso:mode==='online'?payload.fetchedAt:null,calendarVerified:mode==='demo'||(payload.calendar?.verified&&!payload.calendar?.closed&&payload.calendar?.open===570),inputsFresh:mode!=='online'||liveInputsCurrent(payload)});
 const spot=payload.data.spx.at(-1)?.close;const lastSpotTime=payload.data.spx.at(-1)?.timestamp;const coherentChain=lastSpotTime?payload.chain.filter(q=>Math.abs(Date.parse(sessionUtc(payload.data.date,minuteOf(lastSpotTime)))-Date.parse(q.timestamp))<=120000):[];const gamma=spot&&coherentChain.length?gammaProfile(coherentChain,spot,payload.cutoffIso):{rows:[],rejected:payload.chain.length,assumption:'Requires an SPX spot and option snapshot within two minutes, chain gamma and timestamped open interest.'};
 json(res,200,{...payload,analysis,gamma,modelLoadError:bundle.loadError||null});return;}
 const allowed=new Map([['/','index.html'],['/app.js','app.js'],['/styles.css','styles.css']]);const name=allowed.get(url.pathname);if(!name){json(res,404,{error:'Not found'});return;}
 const content=await readFile(resolve(appRoot,'public',name));res.writeHead(200,{'Content-Type':name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",'X-Content-Type-Options':'nosniff'});res.end(content);
 }catch(error){json(res,500,{error:safeError(error)});}});
server.listen(port,host,()=>console.log(`SPX Machine Intelligence http://${host}:${server.address()?.port} (read-only; separate from any existing dashboard)`));
