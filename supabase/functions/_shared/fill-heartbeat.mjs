/* The primary owns its pulse; legacy reads support migration rollout only. */
export async function readPrimaryHeartbeat(readRows) {
  let primary;
  try { primary = (await readRows('publication_workers?id=eq.fill_github-actions&select=data'))?.[0]?.data; }
  catch { /* table may not exist yet during rollout */ }
  if (primary) return ['started','running','completed'].includes(primary.state) ? primary : null;
  return (await readRows('secrets?id=eq.fill_heartbeat&select=data'))?.[0]?.data || null;
}
