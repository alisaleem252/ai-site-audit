import { ranked } from './audit.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

function facts(r) {
  const c = r.checks || {};
  return {
    proposals: c['content-refresh'] ? (c['content-refresh'].changes || []).filter((x) => x.after).length : '',
    originality: c.originality?.score ?? '',
    fact: c['fact-check']?.summary?.score ?? '',
    contradicted: c['fact-check']?.summary?.contradicted ?? '',
  };
}

export function toCsv(state) {
  const head = ['priority', 'score', 'url', 'lastmod', 'outdated_statements', 'originality_score', 'fact_check_score', 'contradicted_claims', 'reasons', 'error'];
  const rows = ranked(state).map((r) => { const f = facts(r); return [r.priority.label, r.priority.score, r.url, r.lastmod || '', f.proposals, f.originality, f.fact, f.contradicted, r.priority.reasons.join('; '), r.error || ''].map(csvCell).join(','); });
  return [head.join(','), ...rows].join('\n') + '\n';
}

export function toHtml(state, { title = 'Content audit' } = {}) {
  const rows = ranked(state);
  const count = (l) => rows.filter((r) => r.priority.label === l).length;
  const detail = (r) => {
    const c = r.checks || {}, out = [];
    for (const ch of (c['content-refresh']?.changes || []).filter((x) => x.after)) out.push(`<li><b>Outdated:</b> <del>${esc(ch.before)}</del><br><ins>${esc(ch.after)}</ins>${ch.source_url ? ` <a href="${/^https?:/i.test(ch.source_url) ? esc(ch.source_url) : '#'}" rel="noopener noreferrer">source</a>` : ''}</li>`);
    for (const m of c.originality?.matches || []) out.push(`<li><b>Overlap:</b> “${esc(m.sentence)}” (${esc(m.run_words)} words also on ${esc(m.host || m.url)})</li>`);
    for (const cl of (c['fact-check']?.claims || []).filter((x) => x.verdict === 'contradicted' || x.verdict === 'partly')) out.push(`<li><b>${esc(cl.verdict)}:</b> ${esc(cl.claim)}${cl.evidence ? `<br><small>“${esc(cl.evidence)}”</small>` : ''}</li>`);
    if (r.error) out.push(`<li><b>Error:</b> ${esc(r.error)}</li>`);
    return out.length ? `<details><summary>${out.length} detail${out.length > 1 ? 's' : ''}</summary><ul>${out.join('')}</ul></details>` : '';
  };
  const body = rows.map((r) => {
    const f = facts(r), cls = r.priority.label.toLowerCase();
    return `<tr><td><span class="pill ${cls}">${esc(r.priority.label)}</span><div class="score">${esc(r.priority.score)}</div></td>
<td><a href="${/^https?:/i.test(r.url) ? esc(r.url) : '#'}" rel="noopener noreferrer">${esc(r.url.replace(/^https?:\/\/(www\.)?/, ''))}</a><div class="muted">${esc(r.priority.reasons.join(' · '))}</div>${detail(r)}</td>
<td>${esc(f.proposals)}</td><td>${esc(f.originality)}</td><td>${esc(f.fact)}</td><td class="muted">${esc((r.lastmod || '').slice(0, 10))}</td></tr>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{--bg:#f6f7fb;--fg:#1b1c22;--mut:#6a6d7c;--card:#fff;--line:#e3e5ee;--hi:#dc2626;--md:#d97706;--lo:#16a34a}@media(prefers-color-scheme:dark){:root{--bg:#121318;--fg:#ececf2;--mut:#9a9db0;--card:#1b1c24;--line:#2c2e3a;--hi:#f87171;--md:#fbbf24;--lo:#4ade80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}main{max-width:1100px;margin:0 auto;padding:28px 20px 60px}h1{margin:0 0 4px;font-size:24px}
.muted{color:var(--mut);font-size:13px}.stats{display:flex;gap:12px;margin:18px 0;flex-wrap:wrap}.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 18px;min-width:110px}.stat b{display:block;font-size:26px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}th,td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut)}
.pill{font-size:12px;font-weight:700;padding:1px 9px;border-radius:999px;border:1px solid currentColor}.high{color:var(--hi)}.medium{color:var(--md)}.low{color:var(--lo)}.error{color:var(--mut)}.score{font-size:12px;color:var(--mut);margin-top:4px}
a{color:#4f46e5;word-break:break-all}details{margin-top:6px}summary{cursor:pointer;font-size:13px;color:var(--mut)}li{margin:6px 0}del{color:var(--hi)}ins{color:var(--lo);text-decoration:none}</style></head><body><main>
<h1>${esc(title)}</h1><div class="muted">${rows.length} pages checked · generated ${esc(new Date().toISOString().slice(0, 10))} · highest priority first</div>
<div class="stats"><div class="stat"><b class="high">${count('High')}</b>High</div><div class="stat"><b class="medium">${count('Medium')}</b>Medium</div><div class="stat"><b class="low">${count('Low')}</b>Low</div><div class="stat"><b>${count('Error')}</b>Errors</div></div>
<table><thead><tr><th>Priority</th><th>Page</th><th>Outdated</th><th>Originality</th><th>Facts</th><th>Last modified</th></tr></thead><tbody>
${body}
</tbody></table><p class="muted">Spot checks, not guarantees. Review each suggestion before changing a page.</p></main></body></html>
`;
}
