import { readout, defaults } from './core/readout.ts';
import { buildPlaybookHistory } from './core/playbook-history.ts';
import { buildEmaRetest } from './core/ema-retest.ts';
import { calculateNetworkRegime, NETWORK_SYMBOLS } from './core/network-regime.ts';
import { calculateSpongeNetwork, parseSpongeNetworkBundle } from './core/sponge-network.ts';
import { calculateSpongeMissing, parseSpongeMissingBundle } from './core/sponge-missing.ts';
import { calculateSpongeInteractions, parseSpongeInteractionBundle } from './core/sponge-interactions.ts';
import { detectedReversalCode, reversalCopy } from './core/reversal-warning.ts';
import { classifyNewsHeadline } from './core/news-context.ts';
import { identifyNewsCompanies, NEWS_COMPANY_REGISTRY_AVAILABLE_AT } from './core/news-companies.ts';

export const SECTORS = [...NETWORK_SYMBOLS];
export const et = new Intl.DateTimeFormat('en-CA', {timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
export function localTimestamp(timestamp) {
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return null;
  const p=Object.fromEntries(et.formatToParts(new Date(timestamp)).map(x=>[x.type,x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000`;
}
export function minuteOf(timestamp) {return +timestamp.slice(11,13)*60 + +timestamp.slice(14,16);}
export function normalCdf(x) {const a=Math.abs(x),t=1/(1+.2316419*a),d=.3989422804014327*Math.exp(-a*a/2);const p=1-d*t*(.319381530+t*(-.356563782+t*(1.781477937+t*(-1.821255978+t*1.330274429))));return x>=0?p:1-p;}
/** Educational European option model; not a provider quote or fill estimate. */
export function blackScholes({spot,strike,years,iv,rate=0.04,right='CALL'}) {
  if (!['CALL','PUT'].includes(right)||![spot,strike,years,iv,rate].every(Number.isFinite)||spot<=0||strike<=0||years<=0||iv<=0) return null;
  const root=Math.sqrt(years),d1=(Math.log(spot/strike)+(rate+iv*iv/2)*years)/(iv*root),d2=d1-iv*root;
  const pdf=Math.exp(-d1*d1/2)/Math.sqrt(2*Math.PI),disc=Math.exp(-rate*years),call=right==='CALL';
  const price=call?spot*normalCdf(d1)-strike*disc*normalCdf(d2):strike*disc*normalCdf(-d2)-spot*normalCdf(-d1);
  const theta=(-spot*pdf*iv/(2*root)+(call?-rate*strike*disc*normalCdf(d2):rate*strike*disc*normalCdf(-d2)))/365;
  return {price,delta:call?normalCdf(d1):normalCdf(d1)-1,gamma:pdf/(spot*iv*root),theta,vega:spot*pdf*root/100};
}
export function gammaProfile(chain, spot, cutoffIso) {
  const book=new Map(); let rejected=0;
  for(const q of chain) {
    if(!Number.isFinite(Date.parse(q.timestamp))||!Number.isFinite(Date.parse(cutoffIso))||![q.strike,q.gamma,q.openInterest,spot].every(Number.isFinite)||q.gamma<0||q.openInterest<0||q.strike<=0||!['CALL','PUT'].includes(q.right)||Date.parse(q.timestamp)>Date.parse(cutoffIso)){rejected++;continue;}
    // Never backfill present-day OI into an earlier replay cutoff.
    if(!Number.isFinite(Date.parse(q.openInterestTimestamp||q.openInterestAsOf))||Date.parse(q.openInterestTimestamp||q.openInterestAsOf)>Date.parse(cutoffIso)){rejected++;continue;}
    if(q.greeksTimestamp&&(!Number.isFinite(Date.parse(q.greeksTimestamp))||Date.parse(q.greeksTimestamp)>Date.parse(cutoffIso)||Math.abs(Date.parse(q.greeksTimestamp)-Date.parse(q.timestamp))>60000)){rejected++;continue;}
    const row=book.get(q.strike)||{strike:q.strike,call:0,put:0,net:0,callOI:0,putOI:0};
    const g=q.gamma*q.openInterest*100*spot*spot*.01;
    if(q.right==='CALL'){row.call+=g;row.callOI+=q.openInterest;}else{row.put-=g;row.putOI+=q.openInterest;}
    row.net=row.call+row.put;book.set(q.strike,row);
  }
  return {rows:[...book.values()].sort((a,b)=>a.strike-b.strike),rejected,assumption:'Call-positive / put-negative inventory assumption; not observed dealer inventory, a pin forecast, or a buy/sell signal.'};
}
export function riskProfile(legs, spot, range=80) {
  if(!Array.isArray(legs)||legs.length>8||!Number.isFinite(spot)||spot<=0||!Number.isFinite(range)||range<=0||range>100000) throw new Error('Valid spot and at most eight legs required.');
  for(const l of legs) if(!['CALL','PUT'].includes(l.right)||![l.strike,l.premium,l.quantity].every(Number.isFinite)||l.strike<=0||l.premium<0||!Number.isInteger(l.quantity)||Math.abs(l.quantity)>100)throw new Error('Invalid option leg.');
  return Array.from({length:81},(_,i)=>{const price=Math.max(0,spot-range)+i*(spot+range-Math.max(0,spot-range))/80;return {price,pnl:legs.reduce((sum,l)=>sum+l.quantity*100*((l.right==='CALL'?Math.max(price-l.strike,0):Math.max(l.strike-price,0))-l.premium),0)};});
}
export function newsRoutes(articles, cutoff) {
  return articles.filter(a=>Date.parse(a.timestamp||a.publishedAt)<=Date.parse(cutoff)&&(!a.retrievedAt||Date.parse(a.retrievedAt)<=Date.parse(cutoff))&&(!a.firstSeenAt||Date.parse(a.firstSeenAt)<=Date.parse(cutoff))).map(a=>{
    const registryKnown=Date.parse(cutoff)>=Date.parse(NEWS_COMPANY_REGISTRY_AVAILABLE_AT);const companies=registryKnown?identifyNewsCompanies(a.title||''):[]; const cues=classifyNewsHeadline(a.title||'');
    const sectors=[...new Set(companies.map(c=>c.sector))];
    if(registryKnown&&!companies.length&&/\b(artificial intelligence|OpenAI|AI)\b/i.test(a.title||''))sectors.push('XLK');
    const targets=new Set(sectors);for(const cue of cues){if(cue.ruleId.startsWith('oil-'))targets.add('USO');if(cue.ruleId.startsWith('yields-'))targets.add('TNX');if(cue.ruleId.startsWith('fed-')||cue.ruleId.startsWith('inflation-'))SECTORS.forEach(s=>targets.add(s));if(cue.ruleId.startsWith('tariffs-'))['XLI','XLY','XLB'].forEach(s=>targets.add(s));}
    return {...a,sectors,targets:[...targets],companies:companies.map(c=>c.ticker),cues: cues.map(c=>({direction:c.direction,ruleId:c.ruleId})),forecastInfluence:false};
  });
}
export function analyze(data,{cutoff=data.asOf,models={},news=[],cutoffIso=null,newsCutoffIso=null,inputsFresh=true,calendarVerified=true}={}) {
  const allowed=Math.min(cutoff,data.asOf,data.session.close-1),view=readout(data,allowed,defaults);
  const active=!view.stale&&calendarVerified?detectedReversalCode(view.variantCandidates):null;
  if(!calendarVerified){view.active=null;view.variantCandidates=view.variantCandidates.map(p=>({...p,matches:false}));view.execution={passed:false,direction:'neutral',detail:'Session calendar unverified or closed; execution criteria held.'};}
  const network=calculateNetworkRegime(data.context.filter(c=>SECTORS.includes(c.symbol)),allowed,data.date,data.session.close);
  const input={spxBars:data.spx,spyBars:data.spy,sectorContext:data.context.filter(c=>SECTORS.includes(c.symbol)),macroContext:data.context.filter(c=>['USO','TNX'].includes(c.symbol))};
  let sponge={status:'unavailable',reason:'No licensed, independently validated model bundle is installed. The learned model is never trained on live ticks.',horizons:[]};
  try {
    if(!calendarVerified)sponge={status:'unavailable',reason:'The cash-session calendar is unverified or closed. Forecast horizons are held until session bounds are established.',horizons:[]};
    else if(!inputsFresh && Object.keys(models).length)sponge={status:'unavailable',reason:'Configured live sources do not establish current real-time freshness for every required input. Delayed data is retained as context.',horizons:[]};
    else if(models.missing)sponge=calculateSpongeMissing(input,allowed,data.date,parseSpongeMissingBundle(models.missing),data.session.close);
    else if(models.interactions)sponge=calculateSpongeInteractions(input,allowed,data.date,parseSpongeInteractionBundle(models.interactions),data.session.close);
    else if(models.sponge)sponge=calculateSpongeNetwork(input,allowed,data.date,parseSpongeNetworkBundle(models.sponge),data.session.close);
  }catch(error){sponge={status:'unavailable',reason:`Model rejected: ${error.message}`,horizons:[]};}
  const ema=buildEmaRetest(data,allowed);if(!calendarVerified){ema.status='unavailable';ema.reason='Session calendar unverified or closed; pattern signals held.';ema.bullish={side:'bullish',status:'idle',episode:null};ema.bearish={side:'bearish',status:'idle',episode:null};}
  return {view,history:calendarVerified?buildPlaybookHistory(data,allowed,defaults):{current:null,previous:null,latest:null},ema,network,sponge,reversal:active?{code:active,...reversalCopy(active)}:null,
    news:cutoffIso?newsRoutes(news,newsCutoffIso||cutoffIso):[],cutoff:allowed};
}
