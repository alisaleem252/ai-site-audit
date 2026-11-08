const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
const tag = (block, name) => { const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i')); return m ? decode(m[1]) : ''; };

/** Parse one sitemap or sitemap-index document. */
export function parseSitemap(xml) {
  const urls = [], sitemaps = [];
  for (const m of xml.matchAll(/<sitemap>([\s\S]*?)<\/sitemap>/gi)) { const loc = tag(m[1], 'loc'); if (loc) sitemaps.push(loc); }
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)) { const loc = tag(m[1], 'loc'); if (loc) urls.push({ loc, lastmod: tag(m[1], 'lastmod') || null }); }
  return { urls, sitemaps };
}

/** Fetch a sitemap (following sitemap indexes up to `depth` levels). Returns [{loc, lastmod}] without duplicates. */
export async function loadSitemap(url, { fetchFn = fetch, limit = 5000, depth = 2, seen = new Set() } = {}) {
  if (seen.has(url) || depth < 0) return [];
  seen.add(url);
  const res = await fetchFn(url, { headers: { 'User-Agent': 'ai-site-audit (+https://github.com/alisaleem252/ai-site-audit)' } });
  if (!res.ok) throw new Error(`Could not fetch sitemap ${url}: HTTP ${res.status}`);
  const { urls, sitemaps } = parseSitemap(await res.text());
  const out = [...urls];
  for (const s of sitemaps) {
    if (out.length >= limit) break;
    out.push(...(await loadSitemap(s, { fetchFn, limit, depth: depth - 1, seen })));
  }
  const unique = new Map(out.map((u) => [u.loc, u]));
  return [...unique.values()].slice(0, limit);
}

/** URL list from a .txt or .csv file: first column, header row ignored, http(s) only. */
export function parseUrlList(text) {
  return text.split(/\r?\n/).map((l) => l.trim().split(',')[0].replace(/^"|"$/g, '').trim()).filter((u) => /^https?:\/\//i.test(u)).map((loc) => ({ loc, lastmod: null }));
}

/** Filter by include/exclude (regex source or plain substring) and age (days since lastmod). */
export function filterUrls(list, { include, exclude, olderThan, now = Date.now() } = {}) {
  const re = (s) => { try { return new RegExp(s, 'i'); } catch { return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); } };
  const inc = include && re(include), exc = exclude && re(exclude);
  return list.filter((u) => {
    if (inc && !inc.test(u.loc)) return false;
    if (exc && exc.test(u.loc)) return false;
    if (olderThan && u.lastmod) {
      const t = Date.parse(u.lastmod);
      if (!Number.isNaN(t) && now - t < olderThan * 86400000) return false;
    }
    return true;
  });
}
