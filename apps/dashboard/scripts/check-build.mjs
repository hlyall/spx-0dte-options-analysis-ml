import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const base=new URL('../',import.meta.url);
for(const file of ['public/index.html','public/styles.css','public/app.js']){const text=await readFile(new URL(file,base),'utf8');if(!text.trim())throw new Error(`Missing ${file}`);}
for(const file of ['src/server.mjs','src/analytics.mjs','src/market-bridge.mjs','src/demo.mjs','public/app.js'])execFileSync(process.execPath,['--check',fileURLToPath(new URL(file,base))]);
await import('../src/demo.mjs');
console.log('Portable app assets and server syntax validated; no generated deployment glue required.');
