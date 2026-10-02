import {cleanBars,easternToUtc,filterDates,iso,num,result,symbolName,unavailable,validOption} from '../common.mjs';
const asArray=value=>Array.isArray(value)?value:value?[value]:[];
export function tradierProvider(http,settings={},token) {
  const sandbox=settings.sandbox!==false;
  const base=sandbox?'https://sandbox.tradier.com/v1/':'https://api.tradier.com/v1/';
  const info={id:'tradier',name:`Tradier ${sandbox?'sandbox':'brokerage'} market data`,free:false,requiresCredentials:true,capabilities:{quote:true,bars:['1m','5m','15m','1d'],options:true,optionHistory:false,news:false},notes:'User account/token required. Sandbox 15-minute delay, indices and Greeks unavailable. Production index data also has a 15-minute delay. Brokerage Greeks update hourly; not synchronous with quotes.'};
  const source={mode:sandbox?'delayed':'realtime',delaySeconds:sandbox?900:0,attribution:'Tradier / entitled market data'};
  async function get(path,params) {if(!token)throw new Error('Missing configured token');const url=new URL(path,base);Object.entries(params).filter(([,v])=>v!==undefined).forEach(([k,v])=>url.searchParams.set(k,v));return http.json(url,{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}});}
  const index=symbol=>['SPX','SPXW','VIX','TNX','NDX','XSP','RUT'].includes(symbol);
  // Tradier FAQ distinguishes delayed production index data from option quotes.
  // https://docs.tradier.com/docs/faq
  const marketSource=(symbol,type)=>index(symbol)||String(type).toLowerCase()==='index'
    ? {...source,mode:'delayed',delaySeconds:900} : source;
  return {...info,
    async quote({symbol}) {symbol=symbolName(symbol);if(sandbox&&index(symbol))return unavailable('tradier','Tradier sandbox does not provide index quotes',source);
      const row=asArray((await get('markets/quotes',{symbols:symbol})).quotes?.quote)[0];
      const stamp=num(row?.trade_date),price=num(row?.last);
      return result('tradier',stamp&&price!==null?{symbol,last:price,bid:num(row.bid),ask:num(row.ask),timestamp:iso(stamp)}:null,marketSource(symbol,row?.type));
    },
    async bars({symbol,start,end,interval='5m'}) {symbol=symbolName(symbol);if(sandbox&&index(symbol))return unavailable('tradier','Tradier sandbox does not provide index bars',source);
      if(!info.capabilities.bars.includes(interval))return unavailable('tradier','Unsupported bar interval',source);
      const daily=interval==='1d';const payload=daily?await get('markets/history',{symbol,start,end,interval:'daily'}):await get('markets/timesales',{symbol,start:`${start} 00:00`,end:`${end} 23:59`,interval:interval.replace('m','min'),session_filter:'all'});
      const raw=daily?asArray(payload.history?.day):asArray(payload.series?.data);
      const parsed=cleanBars(raw.map(row=>({symbol,interval,date:daily?row.date:row.time?.slice(0,10),timestamp:daily?iso(`${row.date}T00:00:00Z`):num(row.timestamp)?iso(num(row.timestamp)*1000):easternToUtc(`${row.time}:00`),timestampKind:daily?'session-date':'bar-open',open:num(row.open),high:num(row.high),low:num(row.low),close:num(row.close),volume:num(row.volume)})));
      const inputSource=marketSource(symbol);
      return result('tradier',filterDates(parsed.rows,start,end),{...inputSource,mode:daily?'daily':inputSource.mode},parsed.rejected?[`${parsed.rejected} invalid bars rejected`]:[]);
    },
    async options({symbol='SPX',expiration}) {symbol=symbolName(symbol);if(!expiration)return unavailable('tradier','Explicit expiration required',source);
      const payload=await get('markets/options/chains',{symbol:symbol==='SPXW'?'SPX':symbol,expiration,greeks:sandbox?'false':'true'});
      const raw=asArray(payload.options?.option);let rejected=0;
      const rows=raw.map(row=>{const bidTime=num(row.bid_date),askTime=num(row.ask_date);return {symbol:row.symbol,root:row.root_symbol,expiration:row.expiration_date,strike:num(row.strike),right:String(row.option_type).toUpperCase(),bid:num(row.bid),ask:num(row.ask),bidTimestamp:bidTime?iso(bidTime):null,askTimestamp:askTime?iso(askTime):null,timestamp:bidTime&&askTime?iso(Math.min(bidTime,askTime)):null,timestampKind:'oldest-quote-side',delta:num(row.greeks?.delta),gamma:num(row.greeks?.gamma),theta:num(row.greeks?.theta),vega:num(row.greeks?.vega),iv:num(row.greeks?.mid_iv),greeksUnits:{delta:'premium-points-per-underlying-point',gamma:'delta-per-underlying-point',theta:'provider-reported',vega:'provider-reported'},greeksTimestamp:iso(row.greeks?.updated_at),openInterest:num(row.open_interest),openInterestTimestamp:null,volume:num(row.volume)};}).filter(row=>{if(!validOption(row)||!row.bidTimestamp||!row.askTimestamp||Math.abs(Date.parse(row.bidTimestamp)-Date.parse(row.askTimestamp))>60000){rejected++;return false;}return true;});
      return result('tradier',rows,source,[...(rejected?[`${rejected} invalid or more than 60-second-incoherent bid/ask quotes rejected`]:[]),'Greeks are separately timestamped hourly data when available, not synchronized to quote time. OI observation date is not supplied.']);
    }
  };
}
