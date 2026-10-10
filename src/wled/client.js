// -----------------------------------------------------------------------------
// HTTP client of one WLED controller (JSON API, port 80 unless the host says
// otherwise). Requests to a controller are sent one at a time: an ESP8266
// serves few connections at once and drops the others.
// -----------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5000;

export class WledError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, unreachable?: boolean }} [details]
   */
  constructor(message, { status, unreachable = false } = {}) {
    super(message);
    this.name = 'WledError';
    this.status = status;
    this.unreachable = unreachable;
  }
}

export class WledClient {
  /**
   * @param {string} host IP address or name, optionally with `:port`
   * @param {object} [options]
   * @param {typeof fetch} [options.fetch] test seam
   * @param {number} [options.timeoutMs]
   */
  constructor(host, { fetch = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.host = host;
    this.fetch = fetch;
    this.timeoutMs = timeoutMs;
    this.queue = Promise.resolve();
  }

  /** URL of the controller's WebSocket. */
  get websocketUrl() {
    return `ws://${this.host}/ws`;
  }

  request(path, { method = 'GET', body } = {}) {
    const run = () => this.send(path, method, body);
    const result = this.queue.then(run, run);
    // The queue only orders the requests: a failure must not block the next.
    this.queue = result.catch(() => {});
    return result;
  }

  async send(path, method, body) {
    let response;
    try {
      response = await this.fetch(`http://${this.host}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const reason = err?.name === 'TimeoutError' ? 'timeout' : (err?.cause?.code ?? err?.message);
      throw new WledError(`${this.host} unreachable (${reason})`, { unreachable: true });
    }
    if (!response.ok) {
      throw new WledError(`${this.host} answered HTTP ${response.status} on ${path}`, {
        status: response.status,
      });
    }
    try {
      return await response.json();
    } catch {
      throw new WledError(`${this.host} sent an invalid JSON answer on ${path}`);
    }
  }

  /** `{ state, info }`, from /json/si, or /json on builds without it. */
  async getStateInfo() {
    let data;
    try {
      data = await this.request('/json/si');
    } catch (err) {
      if (err.status !== 404) {
        throw err;
      }
      data = await this.request('/json');
    }
    if (!data || typeof data !== 'object' || !data.state || !data.info) {
      throw new WledError(`${this.host} did not answer like a WLED controller`);
    }
    return { state: data.state, info: data.info };
  }

  /** Effect names, by id. Read on their own: /json is cut off on ESP8266. */
  getEffects() {
    return this.request('/json/eff');
  }

  /** Palette names, by id (null on builds without palettes). */
  getPalettes() {
    return this.request('/json/pal');
  }

  /** The presets file; an empty object when the controller has none. */
  async getPresets() {
    try {
      const presets = await this.request('/presets.json');
      return presets && typeof presets === 'object' && !Array.isArray(presets) ? presets : {};
    } catch (err) {
      if (err.unreachable) {
        throw err;
      }
      // A missing or broken presets file (crash while saving) is not fatal.
      return {};
    }
  }

  /** Change the state; resolves with the new state (`v: true`). */
  async setState(change) {
    const state = await this.request('/json/state', {
      method: 'POST',
      body: { ...change, v: true },
    });
    return state && typeof state === 'object' && !Array.isArray(state) ? state : null;
  }
}
