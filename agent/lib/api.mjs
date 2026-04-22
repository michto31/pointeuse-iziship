// Client API pour l'endpoint Netlify prod. Aucune dep externe : fetch natif (Node ≥18).

export class RhApiClient {
  constructor({ baseUrl, password, timeoutMs = 30000 }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.token = null;
  }

  async login() {
    const res = await this.#fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'admin', password: this.password })
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); msg = j.error || msg; } catch {}
      throw new Error(`login failed: ${msg}`);
    }
    const data = await res.json();
    if (!data.token) throw new Error('login: no token in response');
    this.token = data.token;
    return data;
  }

  async listWorkers() {
    const res = await this.#fetch('/api/workers', { headers: this.#authHeaders() });
    if (!res.ok) throw new Error(`listWorkers HTTP ${res.status}`);
    return await res.json();
  }

  async generateDoc({ workerId, docType, period }) {
    const body = { worker_id: workerId, doc_type: docType };
    if (period) body.period = period;
    const res = await this.#fetchRetry('/api/rh/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.#authHeaders() },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); msg = j.error || msg; } catch {}
      throw new Error(`generateDoc(${docType}${period ? ' ' + period : ''}): ${msg}`);
    }
    const cd = res.headers.get('content-disposition') || '';
    const m = /filename="([^"]+)"/.exec(cd);
    const filename = (m && m[1]) || `document-${docType}${period ? '-' + period : ''}.bin`;
    const buffer = Buffer.from(await res.arrayBuffer());
    return { filename, buffer };
  }

  #authHeaders() {
    return this.token ? { 'Authorization': 'Bearer ' + this.token } : {};
  }

  async #fetch(pathStr, opts = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(this.baseUrl + pathStr, { ...opts, signal: controller.signal });
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`timeout after ${this.timeoutMs}ms: ${pathStr}`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  // Auto-retry 1x sur 500/502/503 avec 2s de backoff. Pas de retry sur 4xx (fail fast).
  async #fetchRetry(pathStr, opts) {
    const res = await this.#fetch(pathStr, opts);
    if ([500, 502, 503].includes(res.status)) {
      await new Promise(r => setTimeout(r, 2000));
      return await this.#fetch(pathStr, opts);
    }
    return res;
  }
}
