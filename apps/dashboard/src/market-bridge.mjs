import { localTimestamp, minuteOf, SECTORS } from './analytics.mjs';
export function sessionUtc(date, minute, end=false) {
  const guess=Date.parse(`${date}T12:00:00Z`),at=localTimestamp(new Date(guess).toISOString());
  const offset=720-minuteOf(at);
  return new Date(Date.parse(`${date}T00:00:00Z`)+(minute+offset)*60000+(end?59999:0)).toISOString();
}
export function emptyMarket(date,cutoff=959){return {date,previousDate:'',today:date,session:{open:570,close:960},mode:'unavailable',fetchedAt:new Date().toISOString(),asOf:cutoff,sources:[],spx:[],spy:[],priorSpx:[],priorSpy:[],quotes:[],chain:[],parity:{quotes:[],index:[],rate:null},measurement:{strike:null,selection:'Awaiting coherent SPXW quotes'},openingIv:null,openingIvTimestamp:null,priorSpxClose:null,priorSpyClose:null,context:[],spot:null};}
function minuteBar(row,date,cutoff) {
  if(!Number.isFinite(Date.parse(row.timestamp))||Date.parse(row.timestamp)%60000!==0)return null;
  if(row.timestampKind==='session-date'||row.interval!=='1m'||row.source?.mode==='daily')return null;
  const timestamp=localTimestamp(row.timestamp);
  if(!timestamp||timestamp.slice(0,10)!==date||minuteOf(timestamp)>cutoff||!Object.values({open:row.open,high:row.high,low:row.low,close:row.close}).every(x=>Number.isFinite(x)&&x>0)||row.high<Math.max(row.open,row.close)||row.low>Math.min(row.open,row.close))return null;
  // A minute bucket is not evidence of an original quote update; bar labels are for bars only.
  return {...row,timestamp};
}
function vwap(rows){let pv=0,volume=0;return rows.map(b=>{if(minuteOf(b.timestamp)<570)return {...b,vwap:undefined};if(Number.isFinite(b.volume)&&b.volume>=0){pv+=(b.high+b.low+b.close)/3*b.volume;volume+=b.volume;}return {...b,vwap:volume>0?pv/volume:undefined};});}
/** Bridge public normalized UTC rows to the legacy engine's explicit ET minute starts. */
export function marketFromRows({date,cutoff=959,rows=[],options=[],sessionClose=960,mode='delayed',strictReplay=false,quoteCutoffIso=null}) {
  const data=emptyMarket(date,Math.min(cutoff,sessionClose-1));data.mode=mode;data.session.close=sessionClose;
  const cutoffIso=quoteCutoffIso||sessionUtc(date,cutoff,true),warnings=[];
  let valid=rows.filter(r=>(r.kind===undefined||r.kind==='bars')&&r.interval==='1m');const by=new Map();
  const providerSets=new Map();for(const r of valid){const providers=providerSets.get(r.symbol)||new Set();providers.add(r.source?.provider||'unspecified');providerSets.set(r.symbol,providers);}
  const mixed=[...providerSets].filter(([,providers])=>providers.size>1).map(([symbol])=>symbol);if(mixed.length){warnings.push(`Conflicting providers for ${mixed.join(', ')}; select SPX_REPLAY_PROVIDER to avoid mixing feeds.`);valid=valid.filter(r=>!mixed.includes(r.symbol));}
  for(const row of valid){const symbol=row.symbol;if(!symbol)continue;const bar=minuteBar(row,date,data.asOf);if(!bar)continue;const arr=by.get(symbol)||[];arr.push(bar);by.set(symbol,arr);}
  const ordered=s=>[...(by.get(s)||[])].sort((a,b)=>a.timestamp.localeCompare(b.timestamp));
  data.spx=ordered('SPX');data.spy=vwap(ordered('SPY'));
  data.context=[...SECTORS,'USO','TNX'].map(symbol=>({symbol,bars:vwap(ordered(symbol))}));
  const priorDates=[...new Set(valid.filter(r=>r.symbol==='SPX'&&r.timestampKind!=='session-date'&&r.interval==='1m').map(r=>localTimestamp(r.timestamp)?.slice(0,10)).filter(d=>d&&d<date))].sort();
  data.previousDate=priorDates.at(-1)||'';
  if(data.previousDate){for(const [symbol,target] of [['SPX','priorSpx'],['SPY','priorSpy']])data[target]=valid.filter(r=>r.symbol===symbol).map(r=>minuteBar(r,data.previousDate,1439)).filter(Boolean).filter(b=>minuteOf(b.timestamp)>=570&&minuteOf(b.timestamp)<960).sort((a,b)=>a.timestamp.localeCompare(b.timestamp));}
  data.priorSpxClose=null;data.priorSpyClose=null; // A last intraday print is not an official prior-session close.
  const observed=options.filter(q=>q.timestamp&&Date.parse(q.timestamp)<=Date.parse(cutoffIso)&&localTimestamp(q.timestamp)?.slice(0,10)===date&&(q.root||q.rootSymbol||q.symbol)==='SPXW'&&q.expiration===date&&['CALL','PUT'].includes(q.right)&&q.bid>=0&&q.ask>=q.bid&&Number.isFinite(q.strike));
  const spot=data.spx.at(-1)?.close;
  const calls=observed.filter(q=>q.right==='CALL'&&q.bid>0);
  if(calls.length&&spot){const firstTime=calls.reduce((a,b)=>a.timestamp<b.timestamp?a:b).timestamp;const opening=calls.filter(q=>q.timestamp===firstTime);const selectionSpot=opening.find(q=>Number.isFinite(q.underlyingPrice))?.underlyingPrice??data.spx.filter(b=>b.timestamp<=localTimestamp(firstTime)).at(-1)?.close;const selected=[...opening].sort((a,b)=>selectionSpot?Math.abs(a.strike-selectionSpot)-Math.abs(b.strike-selectionSpot):a.strike-b.strike)[0];data.measurement={strike:selected.strike,selection:'Fixed call selected from earliest available chain; not an opening ATM guarantee'};
    data.quotes=observed.filter(q=>q.strike===selected.strike&&q.right==='CALL'&&minuteOf(localTimestamp(q.timestamp))>=570&&minuteOf(localTimestamp(q.timestamp))<=data.asOf).map(q=>({timestamp:localTimestamp(q.timestamp),underlying_timestamp:q.underlyingTimestamp?localTimestamp(q.underlyingTimestamp):undefined,underlying_price:q.underlyingPrice,bid:q.bid,ask:q.ask,strike:q.strike,right:q.right,symbol:'SPXW',expiration:q.expiration,implied_vol:q.iv}));}
  // Latest quote per exact contract, inside one bounded asynchronous snapshot.
  const contractBook=new Map();for(const q of observed){const key=JSON.stringify([q.root||q.rootSymbol||q.symbol,q.expiration,q.strike,q.right]);const old=contractBook.get(key);if(!old||q.timestamp>old.timestamp)contractBook.set(key,q);}
  const latestRows=[...contractBook.values()],latest=latestRows.reduce((m,q)=>Math.max(m,Date.parse(q.timestamp)),-Infinity);
  const scoped=latestRows.filter(q=>latest-Date.parse(q.timestamp)<=60000);
  const chain=scoped.map(q=>{const stamp=q.openInterestTimestamp||q.openInterestAsOf;return {...q,openInterestAsOf:stamp,openInterest:(!stamp&&strictReplay)||(stamp&&(!Number.isFinite(Date.parse(stamp))||Date.parse(stamp)>Date.parse(cutoffIso)))?undefined:q.openInterest};}).sort((a,b)=>a.strike-b.strike||a.right.localeCompare(b.right));
  const chainCoverage={observedContracts:latestRows.length,coherentContracts:chain.length,excludedStaleContracts:latestRows.length-chain.length,windowSeconds:60,scope:'Partial observed chain; not a guarantee of the complete exchange chain.'};
  if(chainCoverage.excludedStaleContracts)warnings.push(`${chainCoverage.excludedStaleContracts} contracts fall outside the 60-second snapshot window and are withheld.`);
  return {data,chain,chainCoverage,warnings,cutoffIso,intraday:!!data.spx.length&&!!data.spy.length};
}
