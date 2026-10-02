import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
export function cashSession(date,calendar,override=null){
 const weekday=new Date(`${date}T12:00:00Z`).getUTCDay(),valid=/^\d{4}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(weekday)&&new Date(`${date}T12:00:00Z`).toISOString().slice(0,10)===date;
 if(!valid)throw new Error('Invalid calendar date');
 if(override){const {open=570,close=960,closed=false,source,verified=false}=override;if(!Number.isInteger(open)||!Number.isInteger(close)||open<0||close>1440||close<=open||typeof source!=='string'||!source.trim())throw new Error('A session override needs valid minute bounds and a source');return {open,close,closed,verified:verified===true,source,kind:'dated override'};}
 const verified=calendar?.schemaVersion===1&&date>=calendar.validFrom&&date<=calendar.validThrough;
 const closed=weekday===0||weekday===6||!!calendar?.closed?.includes(date),close=calendar?.earlyCloses?.[date]||calendar?.regularClose||960;
 return {open:calendar?.regularOpen||570,close,closed,verified,source:calendar?.source||null,kind:closed?'closed':close<960?'early close':verified?'scheduled cash session':'unverified calendar'};
}
export async function loadSession(root,date,env=process.env){
 let calendar=null,overrides={};try{calendar=JSON.parse(await readFile(resolve(root,'config/cash-calendar.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 try{overrides=JSON.parse(await readFile(resolve(root,'config/sessions.json'),'utf8')).sessions||{};}catch(e){if(e.code!=='ENOENT')throw e;}
 let result=cashSession(date,calendar,overrides[date]);
 if(env.SPX_SESSION_CLOSE||env.SPX_REPLAY_CLOSE){const close=Number(env.SPX_SESSION_CLOSE||env.SPX_REPLAY_CLOSE);if(!Number.isInteger(close)||close<=result.open||close>1440)throw new Error('Invalid session close override');result={...result,close,verified:false,kind:'unverified global environment override'};}
 return result;
}
