import {mkdir,readFile,writeFile,rename,open,unlink,realpath} from 'node:fs/promises';
import {dirname,join,resolve,relative,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {sha256,filterDates,iso} from './common.mjs';
export async function listArchive({directory}) {
  try {const result=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));if(result.schemaVersion!==1||!Array.isArray(result.entries))throw new Error('Invalid archive manifest');return result;}
  catch(error) {if(error.code==='ENOENT')return {schemaVersion:1,entries:[]};throw error;}
}
async function atomic(path,content) {await mkdir(dirname(path),{recursive:true});const temporary=`${path}.${randomUUID()}.tmp`;try {await writeFile(temporary,content,{mode:0o600});await rename(temporary,path);}finally{await unlink(temporary).catch(()=>{});}}
const clean=value=>String(value).replace(/[^a-zA-Z0-9_.-]/g,'_');
export function archiveKey(query) {return sha256(JSON.stringify(Object.entries(query).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b))));}
export async function writeArchive({directory,query,envelope}) {
  directory=resolve(directory);await mkdir(directory,{recursive:true});
  // One writer per directory; never merge manifests by last-writer-wins.
  const lock=await open(join(directory,'.writer.lock'),'wx',0o600).catch(error=>{if(error.code==='EEXIST')throw new Error('Archive locked by another writer');throw error;});
  try {
    const manifest=await listArchive({directory}),key=archiveKey(query);
    const rows=Array.isArray(envelope.data)?envelope.data:envelope.data?[envelope.data]:[];
    const provider=envelope.source.provider;
    const filename=join(clean(provider),clean(query.kind),clean(query.symbol||'NEWS'),`${clean(query.start||query.date||envelope.source.retrievedAt.slice(0,10))}-${key.slice(0,16)}.ndjson`);
    const contents=rows.map(row=>JSON.stringify({...row,source:envelope.source})).join('\n')+(rows.length?'\n':'');
    const entry={key,file:filename,provider,kind:query.kind,symbol:query.symbol||null,date:query.start||query.date||null,interval:query.interval||null,expiration:query.expiration||null,query,sha256:sha256(contents),rowCount:rows.length,status:envelope.status==='unavailable'?'unavailable':envelope.warnings?.length?'partial':'complete',source:envelope.source,warnings:envelope.warnings||[],attempts:envelope.attempts||[]};
    await atomic(join(directory,filename),contents);
    manifest.entries=manifest.entries.filter(row=>row.key!==key).concat(entry);manifest.updatedAt=new Date().toISOString();
    await atomic(join(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
    return entry;
  } finally {await lock.close();await unlink(join(directory,'.writer.lock'));}
}
async function readEntry(directory,entry) {
  if(typeof entry.file!=='string')throw new Error('Invalid archive filename');
  const root=await realpath(directory),target=await realpath(resolve(root,entry.file));
  if(!target.startsWith(root+sep))throw new Error('Archive file escapes configured directory');
  const text=await readFile(target,'utf8');if(sha256(text)!==entry.sha256)throw new Error(`Archive checksum mismatch: ${entry.file}`);
  const rows=text.trim()?text.trim().split('\n').map(line=>JSON.parse(line)):[];
  if(rows.length!==entry.rowCount)throw new Error('Archive row count mismatch');
  return rows;
}
export async function verifyArchive({directory,entry}) {try {await readEntry(directory,entry);return true;}catch{return false;}}
export async function readArchive({directory,symbol,kind='bars',start,end,asOf,provider,interval}) {
  const manifest=await listArchive({directory});
  const entries=manifest.entries.filter(entry=>(!symbol||entry.symbol===symbol)&&entry.kind===kind&&(!provider||entry.provider===provider)&&(!interval||entry.interval===interval)&&entry.status!=='unavailable');
  let rows=[];for(const entry of entries)rows.push(...await readEntry(directory,entry));
  if(start&&end)rows=filterDates(rows,start,end);
  if(asOf) {const cutoff=Date.parse(asOf);if(!Number.isFinite(cutoff))throw new Error('Invalid replay cutoff');rows=rows.filter(row=>{
    if(!iso(row.timestamp)||Date.parse(row.timestamp)>cutoff)return false;
    if(row.timestampKind==='session-date'||row.timestampKind==='observation-date')return false; // Availability within that date is unknown.
    if(row.firstSeenAt&&(!iso(row.firstSeenAt)||Date.parse(row.firstSeenAt)>cutoff))return false;
    if([row.bidTimestamp,row.askTimestamp].some(stamp=>stamp&&(!iso(stamp)||Date.parse(stamp)>cutoff)))return false;
    const duration=/^(\d+)(m|h)$/.exec(row.interval||'');
    return row.timestampKind!=='bar-open'||(duration&&Date.parse(row.timestamp)+Number(duration[1])*(duration[2]==='m'?60000:3600000)<=cutoff);
  }).map(row=>{
    const normalized={...row};
    if(row.greeksTimestamp&&(!iso(row.greeksTimestamp)||Date.parse(row.greeksTimestamp)>cutoff)) {for(const key of ['delta','gamma','theta','vega','iv'])normalized[key]=null;normalized.greeksQuality='after-replay-cutoff';}
    if(row.openInterestTimestamp&&(!iso(row.openInterestTimestamp)||Date.parse(row.openInterestTimestamp)>cutoff))normalized.openInterest=null;
    if(row.underlyingTimestamp&&(!iso(row.underlyingTimestamp)||Date.parse(row.underlyingTimestamp)>cutoff))normalized.underlyingPrice=null;
    return normalized;
  });}
  // Keep provider/interval identity. Do not mix sources or collapse distinct option strikes.
  const unique=new Map();for(const row of rows){const key=JSON.stringify([row.source?.provider,row.interval,row.symbol,row.timestamp,row.expiration,row.strike,row.right]);const previous=unique.get(key);if(previous) {const {source:oldSource,...oldData}=previous;const {source:newSource,...newData}=row;if(JSON.stringify(oldData)!==JSON.stringify(newData))throw new Error('Conflicting duplicate archived observations');}unique.set(key,row);}
  rows=[...unique.values()].sort((a,b)=>String(a.timestamp).localeCompare(String(b.timestamp)));
  return {manifest,entries,rows};
}
