import {cleanBars, dateOnly, filterDates, iso, num, parseCsv, rangeBounds, result, symbolName, todayEastern, unavailable} from '../common.mjs';

export function parseYahoo(payload, symbol, interval) {
  const item = payload?.chart?.result?.[0];
  if (!item || payload?.chart?.error) throw new Error('Yahoo chart unavailable');
  const values = item.indicators?.quote?.[0] || {};
  const rows = (item.timestamp || []).map((seconds, i) => ({symbol, timestamp: iso(seconds * 1000), open: num(values.open?.[i]), high: num(values.high?.[i]), low: num(values.low?.[i]), close: num(values.close?.[i]), volume: num(values.volume?.[i]), interval, timestampKind: interval === '1d' ? 'session-date' : 'bar-open', date: interval === '1d' ? new Intl.DateTimeFormat('en-CA', {timeZone:item.meta.exchangeTimezoneName || 'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(seconds*1000) : undefined}));
  return {...cleanBars(rows), meta: item.meta};
}
const yahooSymbol = symbol => ({SPX:'^GSPC',SPXW:'^GSPC',VIX:'^VIX',TNX:'^TNX'}[symbol] || symbol);
export function yahooProvider(http) {
  const info = {id:'yahoo', name:'Yahoo Finance chart (best effort)', free:true, requiresCredentials:false, capabilities:{quote:true,bars:['1m','5m','15m','30m','1h','1d'],options:false,optionHistory:false,news:false}, notes:'Undocumented chart endpoint; availability, intraday lookback and delay vary. Personal informational use; no redistribution rights conveyed.'};
  return {...info,
    async bars({symbol,start,end,interval='5m'}) {
      symbol=symbolName(symbol); const [from,to]=rangeBounds(start,end);
      if(!info.capabilities.bars.includes(interval)) return unavailable(info.id,'Unsupported bar interval');
      const url=new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(symbol))}`);
      Object.entries({period1:Math.floor(from/1000),period2:Math.floor(to/1000),interval,includePrePost:'true',events:'history'}).forEach(([k,v])=>url.searchParams.set(k,v));
      const parsed=parseYahoo(await http.json(url),symbol,interval);
      if(String(parsed.meta.symbol||'').toUpperCase()!==yahooSymbol(symbol).toUpperCase())throw new Error('Provider symbol identity mismatch');
      const rows=filterDates(parsed.rows,start,end);
      const warnings=['Best-effort informational chart data; exchange entitlement and exact publication delay are not verified.'];
      if(parsed.rejected) warnings.push(`${parsed.rejected} invalid or empty OHLCV rows rejected.`);
      return result(info.id,rows,{mode:interval==='1d'?'daily':'unknown',attribution:'Yahoo Finance / underlying data providers',upstreamSymbol:yahooSymbol(symbol),timestampMeaning:interval==='1d'?'Trading-session date; not intraday availability evidence':'Bar opening timestamp; final active bar can be incomplete',timezone:parsed.meta.exchangeTimezoneName||'America/New_York'},warnings);
    },
    async quote({symbol}) {
      symbol=symbolName(symbol);
      const url=`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(symbol))}?interval=5m&range=1d`;
      const parsed=parseYahoo(await http.json(url),symbol,'5m');
      if(String(parsed.meta.symbol||'').toUpperCase()!==yahooSymbol(symbol).toUpperCase())throw new Error('Provider symbol identity mismatch');
      const last=num(parsed.meta.regularMarketPrice), timestamp=iso(num(parsed.meta.regularMarketTime)*1000);
      if(last===null||!num(parsed.meta.regularMarketTime)) return unavailable(info.id,'No timestamped underlying quote');
      return result(info.id,{symbol,last,timestamp,bid:null,ask:null,unit:symbol==='TNX'?'percent':'USD'},{mode:'unknown',attribution:'Yahoo Finance / underlying data providers',upstreamSymbol:yahooSymbol(symbol),marketState:parsed.meta.marketState||null},['Quote may be delayed or last regular-session close; no executable bid/ask.']);
    }
  };
}
export function parseStooq(text,symbol) {
  if(!/^Date,Open,High,Low,Close/.test(text.trim())) throw new Error('Unexpected Stooq response');
  return cleanBars(parseCsv(text).map(row=>({symbol,date:row.Date,timestamp:iso(`${row.Date}T00:00:00Z`),timestampKind:'session-date',interval:'1d',open:num(row.Open),high:num(row.High),low:num(row.Low),close:num(row.Close),volume:num(row.Volume)})));
}
export function stooqProvider(http) {
  const info={id:'stooq',name:'Stooq daily CSV',free:true,requiresCredentials:false,capabilities:{quote:true,bars:['1d'],options:false,optionHistory:false,news:false},notes:'End-of-day only; access may be blocked by provider. No anti-bot bypass. No redistribution rights conveyed.'};
  const adapter={...info,async bars({symbol,start,end,interval='1d'}) {
    symbol=symbolName(symbol);rangeBounds(start,end);
    if(interval!=='1d') return unavailable(info.id,'Stooq adapter supports daily bars only');
    const mapped={SPX:'^spx',SPXW:'^spx',VIX:'^vix'}[symbol]||(/^[A-Z]+$/.test(symbol)?`${symbol.toLowerCase()}.us`:symbol.toLowerCase());
    const url=new URL('https://stooq.com/q/d/l/');Object.entries({s:mapped,i:'d',d1:start.replaceAll('-',''),d2:end.replaceAll('-','')}).forEach(([k,v])=>url.searchParams.set(k,v));
    const parsed=parseStooq((await http.request(url)).text,symbol);
    return result(info.id,filterDates(parsed.rows,start,end),{mode:'daily',attribution:'Stooq',timestampMeaning:'Session-date marker at midnight UTC, not publication time'},parsed.rejected?[`${parsed.rejected} invalid bars rejected`]:[]);
  },async quote({symbol}) {
    const end=todayEastern(),start=new Date(Date.parse(`${end}T00:00:00Z`)-14*86400000).toISOString().slice(0,10);
    const data=await adapter.bars({symbol,start,end});if(!data.data?.length)return data;
    const bar=data.data.at(-1);return {...data,data:{symbol,last:bar.close,timestamp:bar.timestamp,date:bar.date,bid:null,ask:null,timestampKind:'session-date'},warnings:[...data.warnings,'Daily close only; not a live quote.']};
  }};return adapter;
}
export function parseFred(text,series='DGS10') {
  return parseCsv(text).map(row=>({symbol:series,date:row.observation_date||row.DATE,value:num(row[series]),unit:'percent',timestamp:iso(`${row.observation_date||row.DATE}T00:00:00Z`),timestampKind:'observation-date'})).filter(row=>row.timestamp&&row.value!==null);
}
export function fredProvider(http) {
  return {id:'fred',name:'FRED daily Treasury observations',free:true,requiresCredentials:false,capabilities:{quote:true,bars:[],options:false,optionHistory:false,news:false},notes:'Daily DGS10 observation, not an intraday TNX quote; publication and revisions differ from observation date.',async quote({symbol}) {
    if(!['DGS10','US10Y'].includes(symbolName(symbol)))return unavailable('fred','Use DGS10 or US10Y for daily Treasury series; this adapter never substitutes it for TNX intraday');
    const end=todayEastern(), start=new Date(Date.now()-30*86400000).toISOString().slice(0,10);
    const rows=parseFred((await http.request(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10&cosd=${start}&coed=${end}`)).text);
    const row=rows.at(-1);return result('fred',row?{...row,last:row.value,bid:null,ask:null}:null,{mode:'daily',attribution:'Board of Governors of the Federal Reserve System via FRED',series:'DGS10'},['Observation date is not a point-in-time release timestamp; not suitable as an intraday historical feature without release/revision controls.']);
  }};
}
function xmlText(value='') {return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").trim();}
export function parseRss(text) {
  if(!/<rss\b/i.test(text))throw new Error('Expected RSS feed');
  return [...text.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map(match=>{
    const get=tag=>xmlText(match[1].match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,'i'))?.[1]);
    const link=get('link'),publishedAt=iso(get('pubDate'));
    return {title:get('title'),url:/^https:\/\/www\.federalreserve\.gov\//.test(link)?link:null,publishedAt,timestamp:publishedAt,publisher:'Federal Reserve Board',summary:get('description'),firstSeenAt:new Date().toISOString()};
  }).filter(row=>row.title&&row.url&&row.publishedAt).sort((a,b)=>b.publishedAt.localeCompare(a.publishedAt));
}
export function fedProvider(http) {return {id:'fed',name:'Federal Reserve Board RSS',free:true,requiresCredentials:false,capabilities:{quote:false,bars:[],options:false,optionHistory:false,news:true},notes:'Official Fed releases only; not a comprehensive market or company-news service.',async news({limit=20}={}) {
  return result('fed',parseRss((await http.request('https://www.federalreserve.gov/feeds/press_all.xml')).text).slice(0,Math.max(1,Math.min(100,limit))),{mode:'official-release',attribution:'Federal Reserve Board',timezone:'UTC'},['Publication timestamps differ from locally first-seen times; historic replay must respect both. This feed does not cover all company news.']);
}};}
