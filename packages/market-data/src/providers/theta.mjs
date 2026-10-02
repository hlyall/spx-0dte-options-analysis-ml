import {cleanBars,dateOnly,easternToUtc,filterDates,num,result,symbolName,unavailable,validOption,safeError} from '../common.mjs';
const intervals=['1m','5m','10m','15m','30m','1h'];
export function thetaRows(payload) {
  const rows=Array.isArray(payload)?payload:payload?.response;
  if(!Array.isArray(rows))throw new Error('Unexpected Theta response');
  return rows.flatMap(row=>row.contract&&Array.isArray(row.data)?row.data.map(data=>({...row.contract,...data})):row);
}
export function parseThetaOptions(rows) {
  let rejected=0;
  const parsed=rows.map(row=>({symbol:row.symbol,root:row.symbol,expiration:row.expiration,strike:num(row.strike),right:String(row.right).toUpperCase(),bid:num(row.bid),ask:num(row.ask),bidSize:num(row.bid_size),askSize:num(row.ask_size),timestamp:easternToUtc(row.timestamp),date:row.timestamp?.slice(0,10),timestampKind:'quote',delta:num(row.delta),gamma:num(row.gamma),theta:num(row.theta),vega:num(row.vega)===null?null:num(row.vega)/100,greeksUnits:{delta:'premium-points-per-index-point',gamma:'delta-per-index-point',theta:'provider-reported',vega:'premium-points-per-volatility-percentage-point'},iv:num(row.implied_vol||row.implied_volatility),openInterest:num(row.open_interest),underlyingPrice:num(row.underlying_price),underlyingTimestamp:easternToUtc(row.underlying_timestamp),greeksTimestamp:num(row.gamma)!==null?easternToUtc(row.timestamp):null,openInterestTimestamp:null})).filter(row=>{if(validOption(row))return true;rejected++;return false;});
  return {rows:parsed,rejected};
}
export function thetaProvider(http,settings={}) {
  const base=new URL((settings.baseUrl||'http://127.0.0.1:25503/v3').replace(/\/$/,'')+'/');
  if(base.username||base.password||base.search||base.hash||!['http:','https:'].includes(base.protocol))throw new Error('Invalid Theta base URL');
  if(base.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(base.hostname))throw new Error('Remote Theta endpoints require HTTPS');
  const info={id:'theta',name:'Theta Terminal v3',free:false,requiresCredentials:true,capabilities:{quote:true,bars:intervals,options:true,optionHistory:true,news:false},notes:'Requires a running user-supplied terminal and entitled plans; this adapter never starts or reconfigures it.'};
  async function get(path,parameters) {
    let url=new URL(path,base);Object.entries({...parameters,format:'json'}).filter(([,v])=>v!==undefined).forEach(([k,v])=>url.searchParams.set(k,v));
    const rows=[],seen=new Set();
    for(let page=0;page<20;page++) {
      if(seen.has(url.href))throw new Error('Theta pagination repeated a page');seen.add(url.href);
      const response=await http.request(url);rows.push(...thetaRows(JSON.parse(response.text)));
      if(rows.length>100000)throw new Error('Theta response exceeds row limit');
      const next=response.headers.get('next-page');if(!next||next==='null')return rows;
      const target=new URL(next,url);
      if(target.origin!==base.origin||!target.pathname.startsWith(base.pathname)||!target.pathname.includes('/history/'))throw new Error('Unsafe Theta pagination target');url=target;
    }
    throw new Error('Theta pagination limit exceeded');
  }
  const isIndex=symbol=>['SPX','VIX','TNX','NDX','RUT','XSP'].includes(symbol);
  return {...info,
    async bars({symbol,start,end,interval='5m',startTime='09:30:00',endTime='16:00:00'}) {
      symbol=symbolName(symbol);dateOnly(start);dateOnly(end);
      if(!intervals.includes(interval))return unavailable('theta','Theta adapter supports intraday bars; choose another provider for daily bars');
      const rows=await get(`${isIndex(symbol)?'index':'stock'}/history/ohlc`,{symbol,start_date:start.replaceAll('-',''),end_date:end.replaceAll('-',''),interval,start_time:startTime,end_time:endTime});
      const clean=cleanBars(rows.map(row=>({symbol,date:row.timestamp?.slice(0,10),timestamp:easternToUtc(row.timestamp),timestampKind:'bar-open',interval,open:num(row.open),high:num(row.high),low:num(row.low),close:num(row.close),volume:isIndex(symbol)?null:num(row.volume),vwap:num(row.vwap)})));
      return result('theta',filterDates(clean.rows,start,end),{mode:'historical',attribution:'ThetaData / entitled upstream market data',timestampMeaning:'Bar opening time converted from America/New_York; use completed bars only'},clean.rejected?[`${clean.rejected} invalid or zero OHLCV rows rejected; no gap filling.`]:[]);
    },
    async quote({symbol}) {
      symbol=symbolName(symbol);
      const rows=await get(`${isIndex(symbol)?'index':'stock'}/snapshot/${isIndex(symbol)?'price':'trade'}`,{symbol});
      const row=rows.filter(x=>num(x.price)>0&&easternToUtc(x.timestamp)).sort((a,b)=>a.timestamp.localeCompare(b.timestamp)).at(-1);
      return result('theta',row?{symbol,last:num(row.price),timestamp:easternToUtc(row.timestamp),bid:null,ask:null}:null,{mode:'realtime',delaySeconds:0,attribution:'ThetaData / entitled upstream market data'},['Last trade/index price; timestamp age must be checked, especially outside the trading session.']);
    },
    async options({symbol='SPXW',expiration,strike,right='both',strikeRange=20}) {
      symbol=symbolName(symbol);if(!expiration)return unavailable('theta','An explicit expiration date is required');dateOnly(expiration);
      const parameters={symbol,expiration,strike:strike??'*',right:String(right).toLowerCase(),strike_range:strike?undefined:Math.max(1,Math.min(100,strikeRange))};
      const warnings=[];let rows;
      try { rows=await get('option/snapshot/greeks/all',parameters); }
      catch(error) { warnings.push(`Greeks unavailable (${safeError(error)}); using quote-only snapshots.`); rows=await get('option/snapshot/quote',parameters); }
      const clean=parseThetaOptions(rows);
      let staleGreeks=0;
      for(const row of clean.rows) {
        if(row.greeksTimestamp&&(!row.underlyingTimestamp||Math.abs(Date.parse(row.greeksTimestamp)-Date.parse(row.underlyingTimestamp))>60000)) {
          for(const field of ['delta','gamma','theta','vega','iv'])row[field]=null;
          row.greeksQuality='underlying-stale-or-untimestamped';staleGreeks++;
        } else row.greeksQuality=row.greeksTimestamp?'timestamp-coherent':'unavailable';
      }
      if(staleGreeks)warnings.push(`${staleGreeks} Greek records withheld because their underlying timestamp was missing or more than 60 seconds away.`);
      const identity=row=>JSON.stringify([row.symbol,row.expiration,row.strike,String(row.right).toUpperCase()]);
      try {
        const oi=new Map((await get('option/snapshot/open_interest',parameters)).map(row=>[identity(row),row]));
        for(const row of clean.rows) {
          const match=oi.get(identity(row)),stamp=easternToUtc(match?.timestamp),value=num(match?.open_interest);
          if(value!==null&&value>=0&&stamp&&Date.parse(stamp)<=Date.parse(row.timestamp)) {
            row.openInterest=value;row.openInterestTimestamp=stamp;row.openInterestSessionDate=null;
          }
        }
      } catch(error) {warnings.push(`Open interest unavailable (${safeError(error)}).`);}
      warnings.push('OI uses its separate provider snapshot timestamp; the underlying OI business date is not supplied. Vega is normalized per volatility percentage point; theta retains the provider-reported unit.');
      if(clean.rejected)warnings.push(`${clean.rejected} invalid/crossed/empty quotes rejected.`);
      return result('theta',clean.rows,{mode:'realtime',delaySeconds:0,attribution:'ThetaData / OPRA',expiration},warnings);
    },
    async optionHistory({symbol='SPXW',start,end,expiration,strike,right,interval='1m',startTime='09:30:00',endTime='16:00:00'}) {
      symbol=symbolName(symbol);dateOnly(start);dateOnly(end);dateOnly(expiration);
      if(!(num(strike)>0)||!['CALL','PUT'].includes(String(right).toUpperCase()))return unavailable('theta','Historical option downloads require one explicit strike and CALL/PUT right per request');
      if(!intervals.includes(interval))return unavailable('theta','Unsupported historical quote interval');
      const clean=parseThetaOptions(await get('option/history/quote',{symbol,start_date:start.replaceAll('-',''),end_date:end.replaceAll('-',''),expiration,strike,right:right.toLowerCase(),interval,start_time:startTime,end_time:endTime}));
      return result('theta',filterDates(clean.rows,start,end),{mode:'historical',attribution:'ThetaData / OPRA',expiration,timestampMeaning:'Last quote at each sample time (not OHLC or guaranteed execution)'},clean.rejected?[`${clean.rejected} invalid/crossed/empty quotes rejected.`]:[]);
    }
  };
}
