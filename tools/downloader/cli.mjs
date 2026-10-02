#!/usr/bin/env node
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createMarketDataClient,listArchive,writeArchive,verifyArchive,todayEastern} from '../../packages/market-data/src/index.mjs';
import {archiveKey} from '../../packages/market-data/src/archive.mjs';
import {dateOnly,rangeBounds,symbolName} from '../../packages/market-data/src/common.mjs';

export function parseArgs(argv) {
  const booleans=new Set(['help','list-providers','resume','overwrite']);
  const values=new Set(['config','provider','symbols','symbol','start','end','date','interval','kind','expiration','strike','right','out','max-days','start-time','end-time']);
  const result={};
  for(let i=0;i<argv.length;i++) {const key=argv[i].replace(/^--/,'');if(argv[i]===key||(!booleans.has(key)&&!values.has(key)))throw new Error(`Unknown argument: ${argv[i]}`);if(booleans.has(key))result[key]=true;else {if(!argv[i+1]||argv[i+1].startsWith('--'))throw new Error(`Missing --${key} value`);result[key]=argv[++i];}}
  return result;
}
const help=`SPX Machine Intelligence — standalone historical downloader

node tools/downloader/cli.mjs --kind bars --symbols SPX,SPY --start 2026-09-25 --end 2026-09-30 --interval 1d
node tools/downloader/cli.mjs --kind bars --provider theta --symbol SPX --date 2026-09-30 --interval 1m
node tools/downloader/cli.mjs --kind option-history --provider theta --symbol SPXW --date 2026-09-30 --expiration 2026-09-30 --strike 7700 --right CALL --interval 1m
node tools/downloader/cli.mjs --kind options --symbol SPXW --expiration 2026-10-02
node tools/downloader/cli.mjs --list-providers

Options: --config path, --out directory (default data/downloads), --provider id,
--kind bars|options|option-history|news, --symbols comma,list, --start/--end YYYY-MM-DD,
--date YYYY-MM-DD, --interval 1m|5m|15m|30m|1h|1d, --start-time HH:MM:SS,
--end-time HH:MM:SS, --max-days N (default31, maximum3660), --overwrite.
Resume is automatic after verifying checksums. Unavailable entries are retried.
Snapshot options/news are captured NOW, never relabeled as past observations.
Credentials and provider connections are shared with the dashboard through config + env.
Exit code0: data saved/resumed, 2: one or more requests unavailable, 1: invalid invocation/error.
`;
export function planJobs(args,now=todayEastern()) {
  const kind=args.kind||'bars';if(!['bars','options','option-history','news'].includes(kind))throw new Error('Unsupported kind');
  const start=args.date||args.start||now,end=args.date||args.end||start;
  const [a,b]=rangeBounds(start,end),days=Math.round((b-a)/86400000),maxDays=Number(args['max-days']||31);
  if(!Number.isInteger(maxDays)||maxDays<1||maxDays>3660||days>maxDays)throw new Error(`Date range exceeds --max-days (default31, maximum3660)`);
  if(end>now)throw new Error('Historical end date is in the future');
  if(['options','news'].includes(kind)&&(start!==now||end!==now))throw new Error('Snapshot capture cannot be backdated; use option-history for historical contracts');
  if(['options','option-history'].includes(kind))dateOnly(args.expiration);
  if(kind==='option-history'&&(!(Number(args.strike)>0)||!['CALL','PUT'].includes((args.right||'').toUpperCase())))throw new Error('Option history requires --strike and --right CALL|PUT');
  const symbols=kind==='news'?[null]:(args.symbols||args.symbol||'SPX').split(',').map(symbolName);
  const jobs=[];
  for(let stamp=a;stamp<b;stamp+=86400000)for(const symbol of symbols) {
    const day=new Date(stamp).toISOString().slice(0,10);
    jobs.push({kind,symbol,provider:args.provider,start:day,end:day,interval:args.interval||'5m',expiration:args.expiration,strike:args.strike?Number(args.strike):undefined,right:args.right?.toUpperCase(),startTime:args['start-time'],endTime:args['end-time'],capturedAt:['options','news'].includes(kind)?new Date().toISOString():undefined});
  }
  return jobs;
}
export async function main(argv=process.argv.slice(2),deps={}) {
  const args=parseArgs(argv);if(args.help){console.log(help);return 0;}
  const client=deps.client||await createMarketDataClient({configPath:args.config});
  if(args['list-providers']){console.log(JSON.stringify(client.providers(),null,2));return 0;}
  const jobs=planJobs(args),directory=resolve(args.out||'data/downloads');
  let unavailable=0,saved=0,resumed=0;
  for(const job of jobs) {
    const previous=(await listArchive({directory})).entries.find(entry=>entry.key===archiveKey(job));
    if(!args.overwrite&&previous&&previous.status!=='unavailable'&&await verifyArchive({directory,entry:previous})){resumed++;console.log(JSON.stringify({event:'resumed',symbol:job.symbol,date:job.start,file:previous.file,rows:previous.rowCount}));continue;}
    const method={'option-history':'optionHistory'}[job.kind]||job.kind;
    const envelope=await client[method](job);
    const entry=await writeArchive({directory,query:job,envelope});
    if(entry.status==='unavailable')unavailable++;else saved++;
    console.log(JSON.stringify({event:'saved',symbol:job.symbol,date:job.start,status:entry.status,provider:entry.provider,rows:entry.rowCount,file:entry.file,warnings:entry.warnings,attempts:entry.attempts}));
  }
  console.log(JSON.stringify({event:'complete',saved,resumed,unavailable,directory}));
  return unavailable?2:0;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().then(code=>{process.exitCode=code;}).catch(error=>{console.error(error.message);process.exitCode=1;});
