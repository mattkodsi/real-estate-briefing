/* Public data transport. Share work only while it is in flight; view caches own freshness. */
(function(root) {
  function createDataClient({base, key, fetch: fetcher = root.fetch.bind(root), timeout = 20000}) {
    const pending = new Map();
    const collections = new Map();
    function request(query) {
      if (pending.has(query)) return pending.get(query);
      const controller = new AbortController();
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Data request timed out')); }, timeout);
      });
      const job = Promise.race([deadline, (async () => {
        const res = await fetcher(`${base}/rest/v1/${query}`, {
          cache: 'no-store', signal: controller.signal,
          headers: {apikey: key, Authorization: `Bearer ${key}`},
        });
        if (!res.ok) throw new Error(`Data unavailable (${res.status})`);
        const data = await res.json();
        return {data, range: res.headers.get('content-range')};
      })()]).finally(() => { clearTimeout(timer); pending.delete(query); });
      pending.set(query, job);
      return job;
    }
    async function read(query) { return (await request(query)).data; }
    async function loadAll(query) {
      const rows = [];
      for (;;) {
        const separator = query.includes('?') ? '&' : '?';
        const {data, range} = await request(`${query}${separator}limit=500&offset=${rows.length}`);
        if (!Array.isArray(data)) throw new Error('Invalid data response');
        rows.push(...data);
        const total = /\/(\d+)$/.exec(range || '');
        if (!data.length || (total && rows.length >= Number(total[1]))) return rows;
        // With an unknown server cap, only an empty page proves completion.
      }
    }
    function all(query) {
      if (!collections.has(query)) collections.set(query, loadAll(query).finally(() => collections.delete(query)));
      return collections.get(query);
    }
    return {read, all};
  }
  root.createDataClient = createDataClient;
  if (typeof module !== 'undefined') module.exports = {createDataClient};
})(globalThis);
