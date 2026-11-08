const DEFAULT_BASE = 'https://app.rapidtextai.com/openai';

export class RapidTextAIError extends Error {
  constructor(message, { status, code, type } = {}) {
    super(message);
    this.name = 'RapidTextAIError';
    Object.assign(this, { status, code, type });
  }
}

const HINTS = {
  401: 'Check that your API key is correct.',
  429: 'Another generation or SEO tool is already running on this account. Wait for it to finish.',
  503: 'Web search is not configured on the server, so this tool is unavailable right now.',
};

/** Parse a text/event-stream body into JSON objects; stops at `data: [DONE]`. */
export async function* parseSSE(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      if (!data) continue;
      try { yield JSON.parse(data); } catch { /* ignore partial lines */ }
    }
  }
}

export class RapidTextAI {
  constructor({ apiKey, baseUrl } = {}) {
    this.apiKey = apiKey || process.env.RAPIDTEXTAI_API_KEY;
    this.baseUrl = (baseUrl || process.env.RAPIDTEXTAI_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
    if (!this.apiKey) throw new RapidTextAIError('Missing API key. Set RAPIDTEXTAI_API_KEY (see .env.example).');
  }

  /**
   * Build a request URL. The key is also sent as ?gigsixkey= because the production server currently
   * ignores the Authorization header (verified live on 2026-11-08); the Bearer header is still sent too.
   */
  _url(path) {
    const u = new URL(`${this.baseUrl}${path}`);
    u.searchParams.set('gigsixkey', this.apiKey);
    return u.toString();
  }

  _headers(extra = {}) {
    return { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', ...extra };
  }

  async _fail(res) {
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    const e = body?.error || {};
    throw new RapidTextAIError([e.message || `HTTP ${res.status}`, HINTS[res.status]].filter(Boolean).join(' '),
      { status: res.status, code: e.code, type: e.type });
  }

  async get(path) {
    const res = await fetch(this._url(`${path}`), { headers: this._headers() });
    if (!res.ok) await this._fail(res);
    return res.json();
  }

  /** POST with streaming; resolves with the `result` event's data. onEvent gets every other event. */
  async stream(path, body, { onEvent, signal } = {}) {
    const res = await fetch(this._url(`${path}`), {
      method: 'POST', headers: this._headers({ Accept: 'text/event-stream' }),
      body: JSON.stringify({ ...body, stream: true }), signal,
    });
    if (!res.ok) await this._fail(res);
    let result = null;
    for await (const evt of parseSSE(res.body)) {
      if (evt.type === 'error') {
        const e = evt.error || {};
        throw new RapidTextAIError(e.message || 'The request failed', { code: e.code, type: e.type });
      }
      if (evt.type === 'result') result = evt.data;
      onEvent?.(evt);
    }
    if (!result) throw new RapidTextAIError('The stream ended without a result.');
    return result;
  }

  capabilities() { return this.get('/v2/article/capabilities'); }
  seoCapabilities() { return this.get('/v2/seo/capabilities'); }
  models() { return this.get('/v1/models'); }
  article(params, opts) { return this.stream('/v2/article/generate', params, opts); }
  /** tool: competitor-gap | content-refresh | fact-check | originality | brand-from-url | embeds */
  seo(tool, body, opts) { return this.stream(`/v2/seo/${tool}`, body, opts); }
}
