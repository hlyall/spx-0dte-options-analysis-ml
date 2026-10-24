/* Display-only ladder. OI is unsigned; gamma uses an assumed call+/put− sign. */
const finite=Number.isFinite;
const stamp=value=>typeof value==='string'&&finite(Date.parse(value))?Date.parse(value):NaN;
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function buildLadder({chain=[],spot,spotTime,cutoffIso,date,mode='gamma'}={}) {
 mode=mode==='oi'?'oi':'gamma';
 const cutoff=stamp(cutoffIso),anchorTime=stamp(spotTime);
 const anchor=finite(spot)&&spot>0&&anchorTime<=cutoff&&cutoff-anchorTime<=120000?spot:null;
 const contracts=chain.filter(q=>q.expiration===date&&finite(q.strike)&&q.strike>0&&['CALL','PUT'].includes(q.right));
 const strikes=[...new Set(contracts.map(q=>q.strike))].sort((a,b)=>a-b);
 const centre=anchor===null?strikes[Math.floor(strikes.length/2)]:Math.round(anchor/25)*25;
 const selected=strikes.sort((a,b)=>Math.abs(a-centre)-Math.abs(b-centre)||a-b).slice(0,21).sort((a,b)=>b-a);
 function leg(strike,right){
  const matches=contracts.filter(q=>q.strike===strike&&q.right===right);
  if(matches.length!==1)return null;
  const q=matches[0],oiTime=stamp(q.openInterestTimestamp||q.openInterestAsOf),quoteTime=stamp(q.timestamp),greekTime=q.greeksTimestamp?stamp(q.greeksTimestamp):quoteTime;
  if(!finite(cutoff)||!finite(q.openInterest)||q.openInterest<0||!finite(oiTime)||oiTime>cutoff||!finite(quoteTime)||quoteTime>cutoff)return null;
  if(mode==='oi')return q.openInterest;
  if(anchor===null||cutoff-quoteTime>120000||!finite(greekTime)||greekTime>cutoff||Math.abs(greekTime-quoteTime)>60000||!finite(q.gamma)||q.gamma<0)return null;
  const value=q.gamma*q.openInterest*100*anchor*anchor*.01;
  return finite(value)?value*(right==='PUT'?-1:1):null;
 }
 const rows=selected.map(strike=>{const call=leg(strike,'CALL'),put=leg(strike,'PUT');return {strike,call,put,net:finite(call)&&finite(put)?call+put:null};});
 return {mode,rows,spot:anchor,cutoffIso,complete:rows.filter(r=>finite(r.net)).length};
}
const format=value=>!finite(value)?'—':value.toLocaleString('en-US',{notation:Math.abs(value)>=10000?'compact':'standard',maximumFractionDigits:1});
export function ladderMarkup(view){
 const {rows,mode}=view,oi=mode==='oi',units=oi?'contracts':'$ / 1% SPX move';
 if(!rows.length)return '<div class="empty">No eligible same-expiry option chain. Select Synthetic demo to explore the ladder.</div>';
 const max=Math.max(1,...rows.flatMap(r=>[r.call,r.put,r.net]).filter(finite).map(Math.abs));
 const cell=value=>`<td class="ladder-cell" style="background:${!finite(value)?'var(--input)':`color-mix(in srgb, ${oi?'var(--gold)':value<0?'var(--red)':'var(--cyan)'} ${Math.round(12+48*Math.sqrt(Math.abs(value)/max))}%, var(--panel))`}" title="${finite(value)?esc(value+' '+units):'Missing, duplicate or ineligible input'}">${format(value)}</td>`;
 const nearest=view.spot===null?null:rows.reduce((best,r)=>Math.abs(r.strike-view.spot)<Math.abs(best.strike-view.spot)?r:best).strike;
 return `<p class="quiet">${view.complete}/${rows.length} complete strike pairs · ${units}${view.spot===null?' · SPX anchor unavailable':` · SPX ${format(view.spot)}`}</p><div class="table-scroll ladder-scroll"><table aria-label="${oi?'Open interest':'Gamma proxy'} ladder by descending strike"><thead><tr><th>Strike</th><th>${oi?'Call OI':'Call +'}</th><th>${oi?'Total OI':'Net proxy'}</th><th>${oi?'Put OI':'Put −'}</th></tr></thead><tbody>${rows.map(r=>`<tr class="${r.strike===nearest?'ladder-spot':''}"><td>${format(r.strike)}${r.strike===nearest?' ◂ SPX':''}</td>${cell(r.call)}${cell(r.net)}${cell(r.put)}</tr>`).join('')}</tbody></table></div><p class="footnote">${oi?'Unsigned open interest; not buyer direction.':'Call-positive / put-negative gamma × OI × 100 × SPX² × 1%. This is an assumed exposure proxy, not observed dealer inventory.'} Up to 21 nearest strikes; shaded cells scale within this view. — means unknown, never zero. Snapshot cutoff: ${esc(view.cutoffIso||'unavailable')}.</p>`;
}
