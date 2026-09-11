/* Durable, ordered edits. Set mutations have stable receipt IDs across retries. */
(function (root) {
  const setFields = new Set(['saved', 'read', 'learnedTerms', 'starEvents', 'watchPlayers']);
  const clone = value => JSON.parse(JSON.stringify(value));
  const identity = (field, value) => field === 'saved' ? value.key : value;
  function apply(data, operation) {
    const result = { ...data, ...clone(operation.changes) };
    for (const [field, delta] of Object.entries(operation.sets)) {
      const values = new Map((result[field] || []).map(v => [identity(field, v), v]));
      delta.remove.forEach(key => values.delete(key));
      delta.add.forEach(value => values.set(identity(field, value), value));
      result[field] = [...values.values()];
    }
    return result;
  }
  function createProfileStore(storage, send, onSaved = () => {}) {
    const entries = new Map();
    const key = slug => 'briefing_pending_v3_' + slug;
    function entry(slug) {
      if (!entries.has(slug)) {
        let pending = [];
        try {
          const stored = storage.getItem(key(slug));
          if (stored) pending = JSON.parse(stored);
          else {
            const old = JSON.parse(storage.getItem('briefing_pending_v2_' + slug) || '{}');
            // Older pending snapshots lack a baseline: retain their legacy semantics once.
            if (Object.keys(old).length) {
              pending = [{ id: crypto.randomUUID(), changes: Object.fromEntries(Object.entries(old).map(([k,v]) => [k,v.value])), sets: {} }];
              storage.setItem(key(slug), JSON.stringify(pending));
              storage.removeItem('briefing_pending_v2_' + slug);
            }
          }
        } catch { /* unavailable storage; live edits remain in memory */ }
        if (!Array.isArray(pending)) pending = [];
        entries.set(slug, { pending, current: {}, running: null });
      }
      return entries.get(slug);
    }
    function persist(slug, e) { storage.setItem(key(slug), JSON.stringify(e.pending)); }
    function overlay(slug, data) { return entry(slug).pending.reduce(apply, clone(data)); }
    function observe(slug, data) { entry(slug).current = overlay(slug, data); }
    function enqueue(slug, field, value) {
      const e = entry(slug);
      const operation = { id: crypto.randomUUID(), changes: {}, sets: {} };
      if (setFields.has(field)) {
        const before = new Map((e.current[field] || []).map(v => [identity(field,v), v]));
        const after = new Map(value.map(v => [identity(field,v), v]));
        const add = [...after].filter(([k,v]) => !before.has(k) || JSON.stringify(before.get(k)) !== JSON.stringify(v)).map(([,v]) => clone(v));
        const remove = [...before.keys()].filter(k => !after.has(k));
        if (!add.length && !remove.length) return;
        operation.sets[field] = { add, remove };
      } else operation.changes[field] = clone(value);
      e.pending.push(operation);
      e.current = apply(e.current, operation);
      persist(slug, e);
    }
    function flush(slug) {
      const e = entry(slug);
      if (e.running) return e.running;
      e.running = (async () => {
        while (e.pending.length) {
          // Send in order so scalar changes and set edits have unambiguous chronology.
          const operation = clone(e.pending[0]);
          const mutations = Object.keys(operation.sets).length ? [{id: operation.id, sets: operation.sets}] : [];
          const data = await send(slug, operation.changes, mutations);
          e.pending = e.pending.filter(change => change.id !== operation.id);
          e.current = overlay(slug, data);
          persist(slug, e);
          onSaved(slug, clone(e.current));
        }
      })().finally(() => { e.running = null; });
      return e.running;
    }
    return { enqueue, overlay, observe, flush };
  }
  root.createProfileStore = createProfileStore;
  if (typeof module !== 'undefined') module.exports = { createProfileStore };
})(globalThis);
