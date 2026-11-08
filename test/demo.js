// Offline demo: audits a fake site (sitemap + RapidTextAI API are both mocked). Sample data only; no key, no units.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const PAGES = [
  ['best-crm-for-small-business', '2022-03-14', { stale: 4, orig: 96, fact: 80, contra: 0 }],
  ['email-marketing-benchmarks', '2023-01-09', { stale: 5, orig: 71, fact: 55, contra: 2 }],
  ['how-to-write-a-press-release', '2024-06-20', { stale: 1, orig: 98, fact: 90, contra: 0 }],
  ['seo-checklist', '2021-11-02', { stale: 3, orig: 88, fact: 72, contra: 1 }],
  ['remote-team-tools', '2025-09-30', { stale: 0, orig: 100, fact: 95, contra: 0 }],
  ['social-media-scheduling', '2023-07-18', { stale: 2, orig: 64, fact: 85, contra: 0 }],
];
const by = Object.fromEntries(PAGES.map(([slug, , p]) => [`https://example-blog.test/${slug}`, p]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c;
  const base = `http://127.0.0.1:${server.address().port}`;
  if (req.url === '/sitemap.xml') { res.setHeader('Content-Type', 'application/xml'); return res.end(`<urlset>${PAGES.map(([s, d]) => `<url><loc>https://example-blog.test/${s}</loc><lastmod>${d}</lastmod></url>`).join('')}</urlset>`); }
  const tool = req.url.match(/\/v2\/seo\/([a-z-]+)/)?.[1];
  if (!tool) { res.writeHead(404); return res.end(); }
  const p = by[JSON.parse(b).url] || { stale: 0, orig: 100, fact: 100, contra: 0 };
  const data = {
    'content-refresh': { changes: Array.from({ length: p.stale }, (_, i) => ({ before: `Sample outdated statement ${i + 1} about the market in 2023.`, after: `Sample updated statement ${i + 1} reflecting current data.`, source_url: 'https://example.com/report', applied: true })), summary: { checked: 6, updated: p.stale, old_years: p.stale > 2 ? [{ year: 2022, count: 2 }] : [] } },
    originality: { score: p.orig, checked: 8, matched: p.orig < 100 ? Math.round((100 - p.orig) / 12) : 0, matches: p.orig < 80 ? [{ sentence: 'A distinctive sentence that also appears elsewhere online.', run_words: 10, host: 'other-site.test', url: 'https://other-site.test/post' }] : [] },
    'fact-check': { summary: { checked: 8, score: p.fact, contradicted: p.contra, supported: 5, partly: 1, unverified: 0 }, claims: p.contra ? [{ claim: 'Sample claim that sources contradict.', verdict: 'contradicted', evidence: 'Sample evidence from a source.', source_url: 'https://example.com/s' }] : [] },
  }[tool];
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  await sleep(Number(process.env.MOCK_DELAY ?? 150));
  res.write(`data: ${JSON.stringify({ type: 'result', data })}\n\n`); res.end('data: [DONE]\n\n');
}).listen(0, '127.0.0.1', () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, RAPIDTEXTAI_API_KEY: 'demo-key', RAPIDTEXTAI_BASE_URL: `${base}/openai` };
  console.error('DEMO MODE: fake site and fake API with sample data. No key or units needed.\n');
  const args = process.argv.slice(2);
  spawn(process.execPath, ['bin/cli.js', ...(args.length ? args : ['--sitemap', `${base}/sitemap.xml`, '--checks', 'refresh,originality,fact-check', '--yes', '-o', 'audit-output/demo'])], { env, stdio: 'inherit' })
    .on('exit', (c) => { server.close(); process.exit(c ?? 0); });
});
