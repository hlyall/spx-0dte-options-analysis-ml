import { blackScholes, SECTORS } from './analytics.mjs';
export const DEMO_DATE='2026-10-01';
const local=(day,m)=>`${day}T${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}:00.000`;
export const demoUtc=(m)=>`${DEMO_DATE}T${String(Math.floor(m/60)+4).padStart(2,'0')}:${String(m%60).padStart(2,'0')}:59.999Z`;
function session(symbol,base,start,end,date=DEMO_DATE,phase=0){let total=0,weight=0;return Array.from({length:end-start+1},(_,i)=>{
 const m=start+i,t=m-570,wave=7*Math.sin(t/17)+3*Math.sin(t/5.5), trend=t<90?t*.20:18-(t-90)*.13;
 const close=base*(1+(trend+wave+phase*Math.sin(t/12+phase))/5200),open=base*(1+(trend+wave-.6*Math.sin(i+1)+phase*Math.sin(t/12+phase))/5200);
 const volume=symbol==='SPX'?0:Math.round(10000+4000*(1+Math.sin(i/9+phase)));const high=Math.max(close,open)+base*.00012,low=Math.min(close,open)-base*.00012;
 weight+=(high+low+close)/3*volume;total+=volume;
 return {timestamp:local(date,m),open,high,low,close,volume,vwap:total?weight/total:undefined};});}
export function demoMarket(cutoff=719){
 const asOf=Math.max(570,Math.min(959,Math.floor(cutoff))),spx=session('SPX',5200,570,asOf),spy=session('SPY',520,480,asOf);
 const priorSpx=session('SPX',5170,570,959,'2026-09-30'),priorSpy=session('SPY',517,570,959,'2026-09-30');
 const strike=5210,quotes=spx.map((bar,i)=>{const years=Math.max(1,960-(570+i))/(365*1440),theory=blackScholes({spot:bar.close,strike,years,iv:.14});
 const premium=Math.max(.06,theory.price+(i<80?Math.max(0,i-35)*.2:9*Math.exp(-(i-80)/15)));return {timestamp:bar.timestamp,underlying_timestamp:bar.timestamp,underlying_price:bar.close,bid:Math.max(.01,premium-.08),ask:premium+.08,strike,right:'CALL',expiration:DEMO_DATE,symbol:'SPXW',implied_vol:.14};});
 const spot=spx.at(-1).close,years=(960-asOf)/(365*1440),chain=[];
 for(let k=5125;k<=5275;k+=5)for(const right of ['CALL','PUT']){const g=blackScholes({spot,strike:k,years,iv:.14,right});chain.push({symbol:'SPXW',expiration:DEMO_DATE,strike:k,right,timestamp:demoUtc(asOf),bid:Math.max(0,g.price-.1),ask:g.price+.1,underlyingPrice:spot,iv:.14,openInterest:Math.round(100+2100*Math.exp(-(((k-(right==='CALL'?5250:5175))/22)**2))),openInterestAsOf:'2026-09-30T21:00:00.000Z',greeksUnits:{theta:'premium points per calendar day',vega:'premium points per volatility percentage point'},...g});}
 const context=SECTORS.map((symbol,i)=>({symbol,bars:session(symbol,80+i*15,570,asOf,DEMO_DATE,(i-5)*1.2)}));context.push({symbol:'USO',bars:session('USO',75,570,asOf,DEMO_DATE,-6)},{symbol:'TNX',bars:session('TNX',40,570,asOf,DEMO_DATE,6)});
 const data={date:DEMO_DATE,previousDate:'2026-09-30',today:DEMO_DATE,session:{open:570,close:960},mode:'synthetic',fetchedAt:demoUtc(asOf),asOf,sources:[],spx,spy,priorSpx,priorSpy,quotes,chain:[],parity:{quotes:[],index:[],rate:null},measurement:{strike,selection:'Synthetic fixed-strike call'},openingIv:.14,openingIvTimestamp:local(DEMO_DATE,570),priorSpxClose:priorSpx.at(-1).close,priorSpyClose:priorSpy.at(-1).close,context,spot:null};
 const news=[{title:'Illustrative: Nvidia announces AI infrastructure partnership',timestamp:demoUtc(620),retrievedAt:demoUtc(620),source:'Synthetic example',url:null},{title:'Illustrative: oil prices rise amid supply concerns',timestamp:demoUtc(680),retrievedAt:demoUtc(680),source:'Synthetic example',url:null}];
 return {data,chain,news,cutoffIso:demoUtc(asOf),label:'SYNTHETIC DEMO • invented prices, quotes, news and OI • no trading use',mode:'synthetic'};
}
