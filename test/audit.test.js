import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSitemap, loadSitemap, parseUrlList, filterUrls } from '../src/sitemap.js';
import { runAudit, priority, estimate, emptyState, ranked } from '../src/audit.js';
import { toCsv, toHtml } from '../src/report.js';

const xml = (urls) => `<?xml version="1.0"?><urlset>${urls.map(([l, m]) => `<url><loc>${l}</loc>${m ? `<lastmod>${m}</lastmod>` : ''}</url>`).join('')}</urlset>`;

test('parseSitemap handles urls, lastmod, entities and indexes', () => {
  const r = parseSitemap('<urlset><url><loc>https://a.com/x?a=1&amp;b=2</loc><lastmod>2024-01-01</lastmod></url><url><loc><![CDATA[https://a.com/y]]></loc></url></urlset>');
  assert.deepEqual(r.urls, [{ loc: 'https://a.com/x?a=1&b=2', lastmod: '2024-01-01' }, { loc: 'https://a.com/y', lastmod: null }]);
  assert.deepEqual(parseSitemap('<sitemapindex><sitemap><loc>https://a.com/s1.xml</loc></sitemap></sitemapindex>').sitemaps, ['https://a.com/s1.xml']);
});

test('loadSitemap follows indexes, de-duplicates and guards against loops', async () => {
  const docs = {
    'https://a.com/index.xml': '<sitemapindex><sitemap><loc>https://a.com/s1.xml</loc></sitemap><sitemap><loc>https://a.com/index.xml</loc></sitemap></sitemapindex>',
    'https://a.com/s1.xml': xml([['https://a.com/1'], ['https://a.com/1'], ['https://a.com/2']]),
  };
  const fetchFn = async (u) => ({ ok: u in docs, status: u in docs ? 200 : 404, text: async () => docs[u] });
  const out = await loadSitemap('https://a.com/index.xml', { fetchFn });
  assert.deepEqual(out.map((u) => u.loc), ['https://a.com/1', 'https://a.com/2']);
  await assert.rejects(loadSitemap('https://a.com/missing.xml', { fetchFn }), /HTTP 404/);
});

test('url list parsing and filtering', () => {
  assert.deepEqual(parseUrlList('url,notes\nhttps://a.com/1,hello\n"https://a.com/2"\nnot a url\n').map((u) => u.loc), ['https://a.com/1', 'https://a.com/2']);
  const list = [{ loc: 'https://a.com/blog/old', lastmod: '2022-01-01' }, { loc: 'https://a.com/blog/new', lastmod: '2026-11-01' }, { loc: 'https://a.com/about', lastmod: null }];
  const now = Date.parse('2026-11-08');
  assert.deepEqual(filterUrls(list, { include: '/blog/' }).length, 2);
  assert.deepEqual(filterUrls(list, { exclude: 'about' }).length, 2);
  assert.deepEqual(filterUrls(list, { olderThan: 365, now }).map((u) => u.loc), ['https://a.com/blog/old', 'https://a.com/about']);
  assert.equal(filterUrls(list, { include: '(' }).length, 0, 'an invalid regex is treated as plain text');
});

const refresh = (n) => ({ changes: Array.from({ length: n }, () => ({ before: 'b', after: 'a', source_url: 'https://s.com' })), summary: { old_years: [{ year: 2023 }] } });

test('priority scoring and labels', () => {
  const stale = priority({ checks: { 'content-refresh': refresh(4), originality: { score: 100 } } });
  assert.equal(stale.label, 'High');
  assert.match(stale.reasons.join(' '), /4 outdated statements[\s\S]*2023/);
  assert.equal(priority({ checks: { originality: { score: 100 }, 'content-refresh': { changes: [], summary: {} } } }).label, 'Low');
  const copied = priority({ checks: { originality: { score: 55, matched: 3 } } });
  assert.equal(copied.score, 45); assert.equal(copied.label, 'High');
  assert.match(priority({ checks: { 'fact-check': { summary: { score: 70, contradicted: 2 } } } }).reasons.join(' '), /2 contradicted/);
  assert.equal(priority({ error: 'boom', checks: {} }).label, 'Error');
  assert.equal(estimate(10, ['content-refresh', 'originality']), 90);
});

function fakeClient(behaviour = {}) {
  const calls = [];
  return { calls, async seo(tool, body) {
    calls.push([tool, body.url]);
    if (behaviour[body.url]) { const r = behaviour[body.url](tool, calls.filter((c) => c[1] === body.url).length); if (r instanceof Error) throw r; return r; }
    return tool === 'originality' ? { score: 95, matched: 0, matches: [] } : refresh(1);
  } };
}
const urls = ['https://a.com/1', 'https://a.com/2', 'https://a.com/3'].map((loc) => ({ loc, lastmod: null }));

test('runAudit checks each page sequentially and saves progress after every page', async () => {
  const state = emptyState(); let saves = 0;
  const c = fakeClient();
  const r = await runAudit(c, urls, { checks: ['content-refresh', 'originality'], state, save: async () => { saves++; } });
  assert.equal(saves, 3);
  assert.equal(r.units, 27);
  assert.deepEqual(c.calls.slice(0, 2), [['content-refresh', 'https://a.com/1'], ['originality', 'https://a.com/1']]);
  assert.equal(Object.keys(state.results).length, 3);
});

test('a finished page is skipped on resume; --force redoes it', async () => {
  const state = emptyState();
  await runAudit(fakeClient(), urls, { checks: ['originality'], state });
  const c2 = fakeClient();
  await runAudit(c2, urls, { checks: ['originality'], state });
  assert.equal(c2.calls.length, 0);
  const c3 = fakeClient();
  await runAudit(c3, urls, { checks: ['originality'], state, force: true });
  assert.equal(c3.calls.length, 3);
  // adding a new check only runs the missing one
  const c4 = fakeClient();
  await runAudit(c4, urls.slice(0, 1), { checks: ['originality', 'content-refresh'], state });
  assert.deepEqual(c4.calls, [['content-refresh', 'https://a.com/1']]);
});

test('errors are recorded per page and the run continues; 429 is retried; 401 stops', async () => {
  const state = emptyState();
  const c = fakeClient({
    'https://a.com/1': () => Object.assign(new Error('server exploded'), { status: 502 }),
    'https://a.com/2': (t, n) => (n === 1 ? Object.assign(new Error('busy'), { status: 429 }) : { score: 90, matches: [] }),
  });
  const r = await runAudit(c, urls, { checks: ['originality'], state, retryDelayMs: 1 });
  assert.match(state.results['https://a.com/1'].error, /server exploded/);
  assert.equal(state.results['https://a.com/2'].error, null);
  assert.equal(state.results['https://a.com/3'].error, null);
  assert.equal(state.results['https://a.com/1'].priority.label, 'Error');
  assert.equal(r.units, 6, 'failed calls are not counted');
  const bad = fakeClient({ 'https://a.com/1': () => Object.assign(new Error('Unauthorized'), { status: 401 }) });
  await assert.rejects(runAudit(bad, urls, { checks: ['originality'], state: emptyState() }), /Unauthorized/);
});

test('ranking puts the worst first and errors last; reports escape content', async () => {
  const state = emptyState();
  const c = fakeClient({
    'https://a.com/1': (t) => (t === 'originality' ? { score: 40, matched: 2, matches: [{ sentence: '<script>x</script>', run_words: 9, host: 'e.com' }] } : refresh(5)),
    'https://a.com/2': () => Object.assign(new Error('x'), { status: 500 }),
  });
  await runAudit(c, urls, { checks: ['content-refresh', 'originality'], state, retryDelayMs: 1 });
  const r = ranked(state);
  assert.equal(r[0].url, 'https://a.com/1');
  assert.equal(r.at(-1).priority.label, 'Error');
  const html = toHtml(state, { title: 'T' });
  assert.ok(!html.includes('<script>x</script>') && html.includes('&lt;script&gt;'));
  assert.match(html, /<tbody>[\s\S]*a\.com\/1/);
  const csv = toCsv(state).split('\n');
  assert.match(csv[0], /^priority,score,url/);
  assert.match(csv[1], /^High,/);
  assert.equal(csv.filter(Boolean).length, 4);
});
