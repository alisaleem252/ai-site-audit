export const UNITS = { 'content-refresh': 6, originality: 3, 'fact-check': 6 };
export const CHECK_ALIASES = { refresh: 'content-refresh', 'content-refresh': 'content-refresh', originality: 'originality', original: 'originality', 'fact-check': 'fact-check', facts: 'fact-check', factcheck: 'fact-check' };

export const estimate = (n, checks) => n * checks.reduce((s, c) => s + UNITS[c], 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Turn one URL's raw check results into a priority score (higher = fix sooner) with human-readable reasons. */
export function priority(r) {
  if (r.error && !Object.keys(r.checks || {}).length) return { score: 0, label: 'Error', reasons: [r.error] };
  const reasons = []; let score = 0;
  const c = r.checks || {};
  if (c['content-refresh']) {
    const proposals = (c['content-refresh'].changes || []).filter((x) => x.after).length;
    const old = c['content-refresh'].summary?.old_years || [];
    if (proposals) { score += Math.min(60, proposals * 12); reasons.push(`${proposals} outdated statement${proposals > 1 ? 's' : ''} with newer data`); }
    if (old.length) { score += Math.min(20, old.length * 5); reasons.push(`mentions old year${old.length > 1 ? 's' : ''} (${old.map((y) => y.year ?? y).join(', ')})`); }
  }
  if (c.originality) {
    const gap = Math.max(0, 100 - (c.originality.score ?? 100));
    if (gap) { score += gap; reasons.push(`originality ${c.originality.score}/100 (${c.originality.matched ?? 0} overlap${c.originality.matched === 1 ? '' : 's'})`); }
  }
  if (c['fact-check']) {
    const s = c['fact-check'].summary || {};
    const gap = Math.max(0, 100 - (s.score ?? 100)) * 0.6;
    if (gap) { score += gap; reasons.push(`fact check ${s.score}/100`); }
    if (s.contradicted) { score += s.contradicted * 15; reasons.push(`${s.contradicted} contradicted claim${s.contradicted > 1 ? 's' : ''}`); }
  }
  score = Math.min(100, Math.round(score));
  if (r.error) reasons.push(`partial: ${r.error}`);
  return { score, label: score >= 40 ? 'High' : score >= 15 ? 'Medium' : 'Low', reasons };
}

export const emptyState = () => ({ version: 1, startedAt: new Date().toISOString(), results: {} });

/**
 * Audit URLs one at a time (RapidTextAI runs one job per account at once).
 * - Already-finished URLs in `state` are skipped, so an interrupted run can resume.
 * - A 429 (another job running) is retried with backoff; other errors are recorded per URL.
 * - A 401 stops everything (the key is wrong).
 */
export async function runAudit(client, urls, { checks, state, save = async () => {}, onUrl = () => {}, signal, retryDelayMs = 15000, retries = 3, force = false } = {}) {
  let units = 0, done = 0;
  for (const [i, u] of urls.entries()) {
    if (signal?.aborted) break;
    const prev = state.results[u.loc];
    if (!force && prev && !prev.error && checks.every((c) => prev.checks?.[c])) { onUrl({ url: u.loc, index: i, total: urls.length, status: 'cached' }); continue; }
    onUrl({ url: u.loc, index: i, total: urls.length, status: 'start' });
    const rec = { url: u.loc, lastmod: u.lastmod, checks: { ...(force ? {} : prev?.checks) }, error: null, at: new Date().toISOString() };
    for (const check of checks) {
      if (rec.checks[check]) continue;
      for (let attempt = 0; ; attempt++) {
        try {
          rec.checks[check] = await client.seo(check, { url: u.loc }, { signal });
          units += UNITS[check];
          break;
        } catch (e) {
          if (e.status === 401) throw e;
          if (e.status === 429 && attempt < retries && !signal?.aborted) { await sleep(retryDelayMs * (attempt + 1)); continue; }
          rec.error = `${check}: ${e.message}`;
          break;
        }
      }
      if (rec.error) break;
    }
    rec.priority = priority(rec);
    state.results[u.loc] = rec;
    done++;
    await save(state);
    onUrl({ url: u.loc, index: i, total: urls.length, status: rec.error ? 'error' : 'done', priority: rec.priority });
  }
  return { units, done };
}

/** All results as a list, highest priority first (errors last). */
export function ranked(state) {
  return Object.values(state.results).map((r) => ({ ...r, priority: r.priority || priority(r) }))
    .sort((a, b) => (a.priority.label === 'Error') - (b.priority.label === 'Error') || b.priority.score - a.priority.score);
}
