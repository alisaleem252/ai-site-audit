#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEnv } from '../src/env.js';
import { RapidTextAI } from '../src/api.js';
import { loadSitemap, parseUrlList, filterUrls } from '../src/sitemap.js';
import { runAudit, estimate, emptyState, ranked, CHECK_ALIASES, UNITS } from '../src/audit.js';
import { toCsv, toHtml } from '../src/report.js';

loadEnv();

const HELP = `Usage: ai-site-audit --sitemap <url> [options]
       ai-site-audit --urls urls.txt [options]
       ai-site-audit <url> <url> ... [options]

Checks every page for outdated statements, copied text and wrong claims, then ranks what to fix first.

Where the URLs come from:
  -s, --sitemap <url>     A sitemap.xml (sitemap indexes are followed)
  -u, --urls <file>       A .txt or .csv file with one URL per line (first column)
Narrowing down:
      --include <regex>   Only URLs matching this (for example /blog/)
      --exclude <regex>   Skip URLs matching this
      --older-than <days> Only pages whose sitemap lastmod is older than this (good for stale content)
  -n, --max <n>           Audit at most n pages (default 10)
What to check (units per page):
  -c, --checks <list>     refresh (6), originality (3), fact-check (6). Default: refresh,originality
Running:
  -y, --yes               Go ahead even when the estimated cost is above --confirm-over
      --confirm-over <n>  Ask for --yes above this many units (default 60)
      --force             Re-check pages that already have results
  -o, --out <dir>         Output folder (default ./audit-output); results are saved after every page
      --key <api-key>     Override RAPIDTEXTAI_API_KEY
  -q, --quiet   -h, --help

Re-run the same command to resume an interrupted audit: finished pages are skipped.
Writes report.html, report.csv and state.json to the output folder.`;

let v, pos;
try {
  ({ values: v, positionals: pos } = parseArgs({
    allowPositionals: true,
    options: {
      sitemap: { type: 'string', short: 's' }, urls: { type: 'string', short: 'u' }, include: { type: 'string' }, exclude: { type: 'string' },
      'older-than': { type: 'string' }, max: { type: 'string', short: 'n', default: '10' }, checks: { type: 'string', short: 'c', default: 'refresh,originality' },
      yes: { type: 'boolean', short: 'y' }, 'confirm-over': { type: 'string', default: '60' }, force: { type: 'boolean' },
      out: { type: 'string', short: 'o', default: 'audit-output' }, key: { type: 'string' }, quiet: { type: 'boolean', short: 'q' }, help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (e) { console.error(e.message + '\n\n' + HELP); process.exit(2); }

if (v.help || (!v.sitemap && !v.urls && !pos.length)) { console.log(HELP); process.exit(v.help ? 0 : 2); }
const log = (...a) => { if (!v.quiet) console.error(...a); };
const fail = (m, code = 2) => { console.error(m); process.exit(code); };

const checks = [...new Set(v.checks.split(',').map((c) => CHECK_ALIASES[c.trim().toLowerCase()]))];
if (checks.some((c) => !c)) fail(`--checks must be a list of: refresh, originality, fact-check`);
const max = Number(v.max); if (!Number.isInteger(max) || max < 1) fail('--max must be a positive integer.');
const olderThan = v['older-than'] ? Number(v['older-than']) : undefined;
if (olderThan !== undefined && !(olderThan > 0)) fail('--older-than must be a number of days.');

const ac = new AbortController();
process.on('SIGINT', () => { ac.abort(); console.error('\nStopping after the current page. Progress is saved; re-run to resume.'); });

try {
  // 1. Collect URLs
  let list = pos.filter((u) => /^https?:\/\//i.test(u)).map((loc) => ({ loc, lastmod: null }));
  if (v.sitemap) { log(`Reading sitemap ${v.sitemap}...`); list.push(...(await loadSitemap(v.sitemap))); }
  if (v.urls) list.push(...parseUrlList(await readFile(v.urls, 'utf8')));
  list = [...new Map(list.map((u) => [u.loc, u])).values()];
  const found = list.length;
  list = filterUrls(list, { include: v.include, exclude: v.exclude, olderThan });
  const chosen = list.slice(0, max);
  if (!chosen.length) fail(`No URLs to audit (${found} found, ${list.length} after filters).`, 1);
  log(`${found} URLs found, ${list.length} match your filters, auditing ${chosen.length}.`);

  // 2. Load previous progress, estimate what is still to do, and confirm the spend
  await mkdir(v.out, { recursive: true });
  const statePath = join(v.out, 'state.json');
  let state = emptyState();
  try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch { /* fresh run */ }
  const todo = chosen.filter((u) => v.force || !(state.results[u.loc] && !state.results[u.loc].error && checks.every((c) => state.results[u.loc].checks?.[c])));
  const units = estimate(todo.length, checks);
  log(`Checks: ${checks.map((c) => `${c} (${UNITS[c]})`).join(', ')}. ${todo.length} page(s) to do, about ${units} request units.`);
  if (units > Number(v['confirm-over']) && !v.yes) fail(`That is above ${v['confirm-over']} units. Re-run with --yes to proceed (or lower --max / choose fewer --checks).`);

  // 3. Run
  const client = new RapidTextAI({ apiKey: v.key });
  const t0 = Date.now();
  const r = await runAudit(client, chosen, {
    checks, state, force: v.force, signal: ac.signal,
    save: (s) => writeFile(statePath, JSON.stringify(s, null, 2)),
    onUrl: (e) => {
      if (e.status === 'cached') log(`[${e.index + 1}/${e.total}] ${e.url}  (already done)`);
      else if (e.status === 'start') log(`[${e.index + 1}/${e.total}] ${e.url}`);
      else if (e.status === 'error') log(`    ⚠ failed, continuing`);
      else if (e.status === 'done') log(`    ${e.priority.label} (${e.priority.score})${e.priority.reasons.length ? ': ' + e.priority.reasons.join('; ') : ''}`);
    },
  });

  // 4. Reports (only for the pages in this run, newest results included)
  const wanted = new Set(chosen.map((u) => u.loc));
  const view = { ...state, results: Object.fromEntries(Object.entries(state.results).filter(([k]) => wanted.has(k))) };
  await writeFile(join(v.out, 'report.html'), toHtml(view));
  await writeFile(join(v.out, 'report.csv'), toCsv(view));
  const top = ranked(view).slice(0, 5);
  log(`\nDone in ${Math.round((Date.now() - t0) / 1000)}s, ${r.units} units used. Fix first:`);
  for (const t of top) log(`  ${String(t.priority.score).padStart(3)}  ${t.priority.label.padEnd(6)} ${t.url}`);
  log(`\nReports: ${join(v.out, 'report.html')}  ${join(v.out, 'report.csv')}`);
  process.exit(ac.signal.aborted ? 130 : 0);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
