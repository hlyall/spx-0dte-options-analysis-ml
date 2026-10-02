const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export function createHttp({ fetchImpl = globalThis.fetch, timeoutMs = 12000, retries = 1, minimumRequestIntervalMs = 500 } = {}) {
  const queues = new Map();
  async function request(url, { headers = {}, maxBytes = 25_000_000 } = {}) {
    const origin = new URL(url).origin;
    const previous = queues.get(origin) || Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    queues.set(origin, previous.then(() => gate));
    await previous;
    try {
      for (let attempt = 0; attempt <= retries; attempt++) {
        const response = await fetchImpl(url, { headers: {Accept: 'application/json,text/csv,application/xml;q=0.9,*/*;q=0.5', ...headers}, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
        if (!response.ok) {
          if ([429, 500, 502, 503, 504].includes(response.status) && attempt < retries) {
            const retryHeader = response.headers.get('retry-after');
            const retryDelay = retryHeader && /^\d+$/.test(retryHeader) ? Number(retryHeader) * 1000 : 800 * 2 ** attempt;
            await response.body?.cancel(); await pause(Math.min(retryDelay, 10_000)); continue;
          }
          await response.body?.cancel(); throw new Error(`HTTP ${response.status}`);
        }
        if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new Error('Provider response exceeds size limit'); }
        const reader = response.body?.getReader();
        let bytes = 0; const chunks = [];
        if (reader) { while (true) { const {value, done} = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > maxBytes) { await reader.cancel(); throw new Error('Provider response exceeds size limit'); } chunks.push(Buffer.from(value)); } }
        const text = Buffer.concat(chunks).toString('utf8');
        return {text, headers: response.headers, status: response.status};
      }
    } finally { await pause(minimumRequestIntervalMs); release(); }
  }
  return { request, json: async (url, options) => JSON.parse((await request(url, options)).text) };
}
