/* Durable per-reader pending changes. One network write per reader at a time. */
(function (root) {
  function createProfileStore(storage, send, onSaved = () => {}) {
    const entries = new Map();
    const key = slug => 'briefing_pending_v2_' + slug;
    const clone = value => JSON.parse(JSON.stringify(value));
    function entry(slug) {
      if (!entries.has(slug)) {
        let pending = {};
        try { pending = JSON.parse(storage.getItem(key(slug)) || '{}'); } catch { /* corrupt/unavailable storage */ }
        entries.set(slug, { pending, running: null });
      }
      return entries.get(slug);
    }
    function persist(slug, e) { storage.setItem(key(slug), JSON.stringify(e.pending)); }
    function enqueue(slug, field, value) {
      const e = entry(slug);
      e.pending[field] = { value: clone(value), revision: (e.pending[field]?.revision || 0) + 1 };
      persist(slug, e);
    }
    function overlay(slug, data) {
      const result = { ...data };
      for (const [field, change] of Object.entries(entry(slug).pending)) result[field] = clone(change.value);
      return result;
    }
    function flush(slug) {
      const e = entry(slug);
      if (e.running) return e.running;
      e.running = (async () => {
        while (Object.keys(e.pending).length) {
          const snapshot = clone(e.pending);
          const changes = Object.fromEntries(Object.entries(snapshot).map(([k,v]) => [k,v.value]));
          const data = await send(slug, changes);
          for (const [field, sent] of Object.entries(snapshot)) {
            if (e.pending[field]?.revision === sent.revision) delete e.pending[field];
          }
          persist(slug, e);
          onSaved(slug, overlay(slug, data));
        }
      })().finally(() => { e.running = null; });
      return e.running;
    }
    return { enqueue, overlay, flush };
  }
  root.createProfileStore = createProfileStore;
  if (typeof module !== 'undefined') module.exports = { createProfileStore };
})(globalThis);
