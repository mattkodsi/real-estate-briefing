/* Pure presentation rules shared by the app and regression tests. */
(function(root) {
  function formatPeriod(value, opts) {
    const iso = String(value || '');
    const quarter = /^(\d{4})-Q([1-4])$/.exec(iso);
    if (quarter) return `Q${quarter[2]} ${quarter[1]}`;
    const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(iso);
    if (!match) return 'Date unavailable';
    const y = +match[1], m = +(match[2] || 1), d = +(match[3] || 1);
    const date = new Date(0); date.setFullYear(y, m - 1, d); date.setHours(12,0,0,0);
    if (date.getFullYear() !== y || date.getMonth() !== m-1 || date.getDate() !== d) return 'Date unavailable';
    if (!match[2]) return match[1];
    if (!match[3]) return date.toLocaleDateString('en-US', {month:'long',year:'numeric'});
    return date.toLocaleDateString('en-US', opts);
  }
  function safeHttpUrl(value) {
    try { const u = new URL(value); return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.href : null; }
    catch { return null; }
  }
  function qualifyingSale(s) {
    return ['Sale','Distress'].includes(s.dealType) && s.valueType === 'salePrice' &&
      s.transactionStatus === 'closed' && Number.isFinite(s.valueUsd) && s.valueUsd > 0 &&
      !!s.assetClass && !!s.market && s.market !== 'National';
  }
  function compGroups(stories) {
    const groups = new Map(), seen = new Set();
    for (const s of [...stories].sort((a,b)=>(b._date||'').localeCompare(a._date||''))) {
      if (!qualifyingSale(s)) continue;
      const identity = s.transactionId || `${s._date}/${s.id}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const key = `${s.market} · ${s.assetClass}`;
      if (!groups.has(key)) groups.set(key, {label:key,market:s.market,asset:s.assetClass,deals:[]});
      groups.get(key).deals.push(s);
    }
    return [...groups.values()].sort((a,b)=>b.deals.length-a.deals.length||a.label.localeCompare(b.label));
  }
  const api = {formatPeriod,safeHttpUrl,qualifyingSale,compGroups};
  root.BriefingCore = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
