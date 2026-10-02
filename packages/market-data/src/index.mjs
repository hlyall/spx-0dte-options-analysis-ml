import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHttp} from './http.mjs';
import {fedProvider,fredProvider,stooqProvider,yahooProvider} from './providers/free.mjs';
import {thetaProvider} from './providers/theta.mjs';
import {tradierProvider} from './providers/tradier.mjs';
import {rangeBounds,safeError,symbolName,todayEastern,unavailable} from './common.mjs';
export {readArchive,listArchive,writeArchive,verifyArchive} from './archive.mjs';
export {todayEastern,easternToUtc} from './common.mjs';

export async function loadConfig({configPath,env=process.env}={}) {
  const path=configPath||env.SPX_FEED_CONFIG||fileURLToPath(new URL('../../../config/providers.json',import.meta.url));
  let text;
  try { text=await readFile(path,'utf8'); }
  catch(error) {
    if(error.code!=='ENOENT'||configPath||env.SPX_FEED_CONFIG)throw error;
    text=await readFile(fileURLToPath(new URL('../../../config/providers.default.json',import.meta.url)),'utf8');
  }
  const config=JSON.parse(text);
  if(config.schemaVersion!==1||!config.providers||!config.priority)throw new Error('Unsupported provider configuration');
  if(env.THETA_BASE_URL)config.providers.theta={...config.providers.theta,enabled:true,baseUrl:env.THETA_BASE_URL};
  if(env.TRADIER_TOKEN)config.providers.tradier={...config.providers.tradier,enabled:true,sandbox:env.TRADIER_SANDBOX!=='false'};
  for(const key of ['timeoutMs','retries','minimumRequestIntervalMs','cacheTtlMs']) if(config[key]!==undefined&&(!Number.isFinite(config[key])||config[key]<0))throw new Error('Invalid request configuration');
  return config;
}

/** Server-only provider router. No credentials or private endpoint URLs are returned. */
export async function createMarketDataClient({configPath,config:providedConfig,env=process.env,fetchImpl,plugins=[]}={}) {
  const config=providedConfig||await loadConfig({configPath,env});
  const http=createHttp({...config,fetchImpl});
  const adapters=[yahooProvider(http),stooqProvider(http),fredProvider(http),fedProvider(http),thetaProvider(http,config.providers.theta),tradierProvider(http,config.providers.tradier,env.TRADIER_TOKEN),...plugins];
  if(new Set(adapters.map(x=>x.id)).size!==adapters.length)throw new Error('Provider identifiers must be unique');
  const registered=new Map(adapters.map(adapter=>[adapter.id,adapter]));
  const cache=new Map();
  async function call(method,query={}) {
    if(typeof query==='string')query={symbol:query};
    if(query.symbol)query={...query,symbol:symbolName(query.symbol)};
    if(method==='bars'||method==='optionHistory')rangeBounds(query.start,query.end);
    const key=JSON.stringify([method,query]);
    const hit=cache.get(key);if(hit&&Date.now()-hit.savedAt<(config.cacheTtlMs??60000)&&!query.bypassCache)return structuredClone(hit.data);
    const order=query.provider?[query.provider]:(config.priority[method]||[]);
    const failures=[];
    for(const id of order) {
      const provider=registered.get(id);
      if(!provider||config.providers[id]?.enabled!==true) {failures.push({provider:id,reason:'Provider is not enabled'});continue;}
      if(!provider.capabilities?.[method]||typeof provider[method]!=='function'){failures.push({provider:id,reason:'Capability unsupported'});continue;}
      if(method==='bars'&&!provider.capabilities.bars.includes(query.interval||'5m')){failures.push({provider:id,reason:'Requested interval unsupported'});continue;}
      try {
        const response=await provider[method](query);
        if(response.status!=='unavailable') {
          response.attempts=failures;
          if(cache.size>200)cache.delete(cache.keys().next().value);
          cache.set(key,{savedAt:Date.now(),data:structuredClone(response)});
          return response;
        }
        failures.push({provider:id,reason:response.warnings?.join('; ')||'No data'});
      }catch(error){failures.push({provider:id,reason:safeError(error)});}
    }
    const response=unavailable(query.provider||'none',`No enabled provider returned ${method} data.`,{mode:'unavailable'});response.attempts=failures;
    cache.set(key,{savedAt:Date.now(),data:structuredClone(response)});
    return response;
  }
  return {
    providers:()=>adapters.map(({id,name,free,requiresCredentials,capabilities,notes})=>({id,name,enabled:config.providers[id]?.enabled===true,free,requiresCredentials,capabilities,notes})),
    quote:query=>call('quote',query), bars:query=>call('bars',query), options:query=>call('options',query), optionHistory:query=>call('optionHistory',query),news:query=>call('news',query),
    async snapshot({symbol='SPX',expiration=todayEastern(),date=todayEastern(),interval='5m'}={}) {
      const [quote,bars,options,news]=await Promise.all([call('quote',{symbol}),call('bars',{symbol,start:date,end:date,interval}),call('options',{symbol:symbol==='SPX'?'SPXW':symbol,expiration}),call('news',{})]);
      return {schemaVersion:1,retrievedAt:new Date().toISOString(),symbol,date,quote,bars,options,news,providers:this.providers()};
    }
  };
}
