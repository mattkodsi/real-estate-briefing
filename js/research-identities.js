/* Reviewed identity consolidation. No inference, network access or input mutation. */
(function (root, factory) {
  const api = factory();
  root.ResearchIdentities = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  const list = value => Array.isArray(value) ? value : [];
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  function identity(entry) {
    if (typeof entry.name === 'string' && entry.name.trim() && typeof entry.type === 'string' && entry.type.trim()) {
      return { name: entry.name, type: entry.type };
    }
    if (typeof entry.term === 'string' && entry.term.trim() && !entry.name && !entry.type) return { term: entry.term };
    return null;
  }
  function sameIdentity(snapshot, entry) {
    const current = identity(entry);
    return snapshot && current && Object.keys(snapshot).length === Object.keys(current).length &&
      Object.keys(current).every(key => snapshot[key] === current[key]);
  }
  function groupSignature(review, bySlug) {
    if (!review || review.decision !== 'same_entity' || typeof review.evidence !== 'string' || !review.evidence.trim() ||
        typeof review.reviewedAt !== 'string' || !review.reviewedAt || !review.identities) return null;
    const keys = list(review.keys);
    if (keys.length < 2 || keys.some(key => typeof key !== 'string') || new Set(keys).size !== keys.length) return null;
    if (keys.some(key => !bySlug.has(key) || !sameIdentity(review.identities[key], bySlug.get(key)))) return null;
    const types = keys.map(key => {
      const value = identity(bySlug.get(key));
      return value && ('term' in value ? 'dictionary-term' : 'player:' + value.type);
    });
    if (!types[0] || !types.every(type => type === types[0])) return null;
    return JSON.stringify([...keys].sort(compare));
  }
  function mergeGroup(members) {
    // Long descriptive slugs are preferred; lexical order resolves ties consistently.
    members.sort((a, b) => b.slug.length - a.slug.length || compare(a.slug, b.slug));
    const merged = copy(members[0]);
    merged.identitySlugs = members.map(e => e.slug).sort(compare);
    merged.identityVariants = members.map(copy);
    const names = members.flatMap(e => [e.name || e.term, ...list(e.aliases)]);
    merged.aliases = [...new Set(names.filter(name => typeof name === 'string' && name.trim() && name !== (merged.name || merged.term)))].sort(compare);
    const mentions = new Map();
    for (const entry of members) {
      for (const mention of list(entry.mentions)) {
        if (!mention || typeof mention !== 'object' || Array.isArray(mention)) continue;
        // Missing IDs are not evidence that two events are identical.
        const key = typeof mention.date === 'string' && typeof mention.id === 'string' && mention.id ?
          JSON.stringify([mention.date, mention.id]) : JSON.stringify(['unlinked', entry.slug, mention]);
        const existing = mentions.get(key);
        const rank = ref => ref.referenceReview?.status === 'resolved' ? 2 : ref.referenceReview?.status === 'unavailable' ? 0 : 1;
        if (!existing || rank(mention) > rank(existing)) mentions.set(key, copy(mention));
      }
    }
    merged.mentions = [...mentions.values()].sort((a, b) => compare(b.date || '', a.date || '') || compare(a.id || '', b.id || ''));
    const dates = merged.mentions.map(m => m.date).filter(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)).sort(compare);
    merged.stats = { mentions: merged.mentions.length, firstSeen: dates[0] || null, lastSeen: dates[dates.length - 1] || null };
    if (merged.type) {
      merged.stats.dealVolumeUsd = merged.mentions.reduce((sum, m) => sum + (typeof m.valueUsd === 'number' && Number.isFinite(m.valueUsd) && m.valueUsd >= 0 ? m.valueUsd : 0), 0);
    }
    for (const field of ['markets', 'assetClasses']) {
      if (members.some(e => Array.isArray(e[field]))) merged[field] = [...new Set(members.flatMap(e => list(e[field])))].sort(compare);
    }
    return merged;
  }
  function consolidate(entries) {
    if (!Array.isArray(entries)) return { entries: [], aliases: {} };
    const input = copy(entries);
    const bySlug = new Map();
    const duplicateSlugs = new Set();
    for (const entry of input) {
      if (!entry || typeof entry.slug !== 'string') continue;
      if (bySlug.has(entry.slug)) duplicateSlugs.add(entry.slug);
      bySlug.set(entry.slug, entry);
    }
    for (const slug of duplicateSlugs) bySlug.delete(slug);
    const reviewed = new Map(), distinctPairs = new Set();
    for (const [slug, entry] of bySlug) {
      const signatures = new Set();
      for (const review of list(entry.researchReviews)) {
        if (review && review.decision === 'distinct_related' && list(review.keys).includes(slug)) {
          const keys = list(review.keys).filter(key => typeof key === 'string').sort(compare);
          for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) distinctPairs.add(JSON.stringify([keys[i], keys[j]]));
        }
        const signature = groupSignature(review, bySlug);
        if (signature && review.keys.includes(slug)) signatures.add(signature);
      }
      reviewed.set(slug, signatures);
    }
    const groups = new Map();
    for (const signatures of reviewed.values()) {
      for (const signature of signatures) {
        const keys = JSON.parse(signature);
        const vetoed = keys.some((key, i) => keys.slice(i + 1).some(other => distinctPairs.has(JSON.stringify([key, other]))));
        if (!vetoed && keys.every(key => reviewed.get(key)?.has(signature))) groups.set(signature, keys);
      }
    }
    // A member in two different reviewed sets is ambiguous: don't union transitively.
    const memberships = new Map();
    for (const keys of groups.values()) for (const key of keys) memberships.set(key, (memberships.get(key) || 0) + 1);
    const mergedBySlug = new Map(), aliases = {};
    for (const keys of groups.values()) {
      if (keys.some(key => memberships.get(key) !== 1)) continue;
      const merged = mergeGroup(keys.map(key => bySlug.get(key)));
      for (const key of keys) {
        mergedBySlug.set(key, merged);
        if (key !== merged.slug) Object.defineProperty(aliases, key, { value: merged.slug, enumerable: true, writable: true, configurable: true });
      }
    }
    const output = [], emitted = new Set();
    for (const entry of input) {
      const merged = entry && mergedBySlug.get(entry.slug);
      if (!merged) output.push(entry);
      else if (!emitted.has(merged.slug)) { output.push(merged); emitted.add(merged.slug); }
    }
    return { entries: output, aliases };
  }
  return { consolidate };
}));
