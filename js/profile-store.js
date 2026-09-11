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
  // Web Locks serialize network sends across tabs. The in-context fallback
  // also supports tests and environments without navigator.locks.
  const localLocks = new Map();
  function localLock(name, run) {
    const previous = localLocks.get(name) || Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    localLocks.set(name, next);
    return next.finally(() => { if (localLocks.get(name) === next) localLocks.delete(name); });
  }
  function createProfileStore(storage, send, onSaved = () => {}, locks = root.navigator?.locks) {
    const entries = new Map();
    const prefix = slug => 'briefing_pending_op_v4_' + slug + ':';
    const opKey = (slug, id) => prefix(slug) + id;
    const order = (a, b) => (a.queuedAt || 0) - (b.queuedAt || 0) || a.id.localeCompare(b.id);
    function scan(slug) {
      const operations = [];
      // Each immutable operation owns one key. A tab can neither overwrite
      // another tab's enqueue nor erase it when acknowledging its own request.
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (!key?.startsWith(prefix(slug))) continue;
        const raw = storage.getItem(key);
        if (raw) operations.push(JSON.parse(raw));
      }
      return operations.sort(order);
    }
    function refresh(slug, e) {
      const disk = scan(slug);
      const byId = new Map(disk.map(op => [op.id, op]));
      for (const op of e.pending) if (e.volatile.has(op.id)) byId.set(op.id, op);
      e.pending = [...byId.values()].sort(order);
    }
    function entry(slug) {
      if (!entries.has(slug)) {
        const e = { pending: [], volatile: new Set(), current: {}, running: null };
        entries.set(slug, e);
        try {
          const v3Key = 'briefing_pending_v3_' + slug;
          const v2Key = 'briefing_pending_v2_' + slug;
          const v3 = storage.getItem(v3Key);
          let legacy = v3 ? JSON.parse(v3) : [];
          if (!v3) {
            const old = JSON.parse(storage.getItem(v2Key) || '{}');
            // Legacy snapshots have no baseline, so preserve their replacement semantics once.
            if (Object.keys(old).length) legacy = [{ id: crypto.randomUUID(), changes: Object.fromEntries(Object.entries(old).map(([k,v]) => [k,v.value])), sets: {} }];
          }
          if (Array.isArray(legacy)) {
            e.pending = legacy.map((op, i) => ({ ...op, queuedAt: op.queuedAt || i + 1 }));
            e.volatile = new Set(e.pending.map(op => op.id));
            for (const operation of e.pending) {
              storage.setItem(opKey(slug, operation.id), JSON.stringify(operation));
              e.volatile.delete(operation.id);
            }
            // Remove old snapshots only after every operation is durable.
            storage.removeItem(v3Key); storage.removeItem(v2Key);
          }
          refresh(slug, e);
        } catch { /* storage unavailable: retain any in-memory migrated edits */ }
      }
      return entries.get(slug);
    }
    function overlay(slug, data) {
      const e = entry(slug);
      try { refresh(slug, e); } catch { /* use known pending edits while storage is unavailable */ }
      return e.pending.reduce(apply, clone(data));
    }
    function observe(slug, data) { entry(slug).current = overlay(slug, data); }
    function enqueue(slug, field, value) {
      const e = entry(slug);
      try { refresh(slug, e); } catch { /* the write below reports persistence failure */ }
      const operation = { id: crypto.randomUUID(), queuedAt: e.pending.reduce((latest, op) => Math.max(latest, (op.queuedAt || 0) + 1), Date.now()), changes: {}, sets: {} };
      if (setFields.has(field)) {
        const before = new Map((e.current[field] || []).map(v => [identity(field,v), v]));
        const after = new Map(value.map(v => [identity(field,v), v]));
        const add = [...after].filter(([k,v]) => !before.has(k) || JSON.stringify(before.get(k)) !== JSON.stringify(v)).map(([,v]) => clone(v));
        const remove = [...before.keys()].filter(k => !after.has(k));
        if (!add.length && !remove.length) return;
        operation.sets[field] = { add, remove };
      } else operation.changes[field] = clone(value);
      e.pending.push(operation);
      e.volatile.add(operation.id);
      e.current = apply(e.current, operation);
      storage.setItem(opKey(slug, operation.id), JSON.stringify(operation));
      e.volatile.delete(operation.id);
    }
    function flush(slug) {
      const e = entry(slug);
      if (e.running) return e.running;
      const run = async () => {
        while (true) {
          refresh(slug, e);
          if (!e.pending.length) break;
          const operation = clone(e.pending[0]);
          const mutations = Object.keys(operation.sets).length ? [{id: operation.id, sets: operation.sets}] : [];
          const data = await send(slug, operation.changes, mutations);
          storage.removeItem(opKey(slug, operation.id));
          e.volatile.delete(operation.id);
          e.pending = e.pending.filter(change => change.id !== operation.id);
          e.current = overlay(slug, data);
          onSaved(slug, clone(e.current));
        }
      };
      const name = 'briefing-profile-flush:' + slug;
      const pending = locks?.request ? locks.request(name, run) : localLock(name, run);
      e.running = pending.finally(() => { e.running = null; });
      return e.running;
    }
    return { enqueue, overlay, observe, flush };
  }
  root.createProfileStore = createProfileStore;
  if (typeof module !== 'undefined') module.exports = { createProfileStore };
})(globalThis);
