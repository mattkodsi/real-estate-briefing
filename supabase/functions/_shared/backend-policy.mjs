export function isPushEligible(story) {
 if(typeof story?.pushEligible === 'boolean') return story.pushEligible;
 // Transitional compatibility until every external generator adopts explicit urgency.
 return story?.cadence === 'special' && story?.featured === true && story?.brief !== true;
}
// Prefer complete editorial microcopy. A clipped financial claim can change meaning.
export function pushCopy(title, body) {
 const clean=s=>String(s || '').replace(/\s+/g,' ').trim();
 title=clean(title);body=clean(body);
 return {title:title && [...title].length<=38 ? title : 'CRE Briefing update',
 body:body && [...body].length<=130 ? body : 'Open the briefing for the full story.'};
}
export function discoveryDates(today) {
 return [new Date(Date.parse(today+'T12:00:00Z')-86400000).toISOString().slice(0,10),today];
}
// Preserve individual failed or regressed series with their actual observation date.
export function mergeMarket(old={},fresh={}) {
 const group=(before={},after={})=>Object.fromEntries([...new Set([...Object.keys(before),...Object.keys(after)])].map(k=>{
  const a=after[k], b=before[k];
  return [k,a?.latest && (!b?.latest || a.latest.date>=b.latest.date) ? {...a,stale:false} : b ? {...b,stale:true} : a];
 }));
 return {...fresh,national:group(old.national,fresh.national),zillowNational:group(old.zillowNational,fresh.zillowNational),
 metros:Object.fromEntries([...new Set([...Object.keys(old.metros||{}),...Object.keys(fresh.metros||{})])].map(k=>[k,group(old.metros?.[k],fresh.metros?.[k])]))};
}
export async function checkedFetch(url, init={}, fetcher=fetch) {
 const response=await fetcher(url,{...init,signal:init.signal || AbortSignal.timeout(12000)});
 if(!response.ok) throw new Error(`Upstream request failed (${response.status})`);
 return response;
}
