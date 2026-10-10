// -----------------------------------------------------------------------------
// Live link to one WLED controller over its WebSocket (`ws://<host>/ws`).
//
// WLED sends `{ state, info }` on connection and after every change, whatever
// made it (its app, a button, a schedule, another controller in sync). The
// link reconnects with a growing delay, and a silent connection (controller
// unplugged without closing it) is detected by asking for the state every
// minute: no answer within 10 s closes it.
//
// Node.js 22+ ships a standard WebSocket client: no dependency needed. One
// socket per controller costs a few kilobytes.
// -----------------------------------------------------------------------------

export const SOCKET_TIMINGS = {
  reconnectMinMs: 5_000,
  reconnectMaxMs: 5 * 60_000,
  keepaliveMs: 60_000,
  keepaliveTimeoutMs: 10_000,
};

export class LiveSocket {
  /**
   * @param {object} options
   * @param {string} options.url
   * @param {(data: object) => void} options.onMessage a `{ state, info? }` document
   * @param {() => void} [options.onOpen]
   * @param {() => void} [options.onClose]
   * @param {(url: string) => WebSocket} [options.createSocket] test seam
   * @param {object} [options.timings]
   * @param {object} [options.logger]
   */
  constructor({ url, onMessage, onOpen, onClose, createSocket, timings, logger }) {
    this.url = url;
    this.onMessage = onMessage;
    this.onOpen = onOpen ?? (() => {});
    this.onClose = onClose ?? (() => {});
    this.createSocket = createSocket ?? ((target) => new WebSocket(target));
    this.timings = { ...SOCKET_TIMINGS, ...timings };
    this.logger = logger;
    this.socket = null;
    this.connected = false;
    this.stopped = true;
    this.delay = this.timings.reconnectMinMs;
    this.reconnectTimer = null;
    this.keepaliveTimer = null;
    this.answerTimer = null;
    this.askedAgain = false;
  }

  start() {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.teardown();
  }

  connect() {
    let socket;
    try {
      socket = this.createSocket(this.url);
    } catch (err) {
      this.logger?.debug(`WebSocket ${this.url}: ${err.message}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (this.socket !== socket) {
        return;
      }
      this.connected = true;
      this.delay = this.timings.reconnectMinMs;
      this.keepaliveTimer = setInterval(() => this.ping(), this.timings.keepaliveMs);
      this.keepaliveTimer.unref?.();
      this.onOpen();
    });
    socket.addEventListener('message', (event) => {
      if (this.socket === socket) {
        this.receive(event.data);
      }
    });
    const closed = () => {
      if (this.socket !== socket) {
        return;
      }
      const wasConnected = this.connected;
      this.teardown();
      if (wasConnected) {
        this.onClose();
      }
      this.scheduleReconnect();
    };
    socket.addEventListener('close', closed);
    socket.addEventListener('error', closed);
  }

  receive(raw) {
    clearTimeout(this.answerTimer);
    this.answerTimer = null;
    if (typeof raw !== 'string') {
      // Binary frames are the live LED preview, only sent when asked for.
      return;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      this.logger?.debug(`WebSocket ${this.url}: invalid JSON ignored`);
      return;
    }
    if (!data || typeof data !== 'object' || !data.state) {
      // A busy controller answers `{ "error": ... }` instead of its state: ask
      // once more, it sends the state when it can.
      if (!this.askedAgain) {
        this.askedAgain = true;
        this.send({ v: true });
      }
      return;
    }
    this.askedAgain = false;
    this.onMessage(data);
  }

  ping() {
    if (!this.send({ v: true })) {
      return;
    }
    clearTimeout(this.answerTimer);
    this.answerTimer = setTimeout(() => {
      // A dead link may never fire `close`: give up on it right away.
      this.logger?.debug(`WebSocket ${this.url}: no answer, closing`);
      const wasConnected = this.connected;
      this.teardown();
      if (wasConnected) {
        this.onClose();
      }
      this.scheduleReconnect();
    }, this.timings.keepaliveTimeoutMs);
    this.answerTimer.unref?.();
  }

  send(message) {
    if (!this.connected || !this.socket) {
      return false;
    }
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  teardown() {
    clearInterval(this.keepaliveTimer);
    clearTimeout(this.answerTimer);
    this.keepaliveTimer = null;
    this.answerTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    if (socket) {
      try {
        socket.close();
      } catch {
        // already closed
      }
    }
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) {
      return;
    }
    const delay = this.delay;
    this.delay = Math.min(this.delay * 2, this.timings.reconnectMaxMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) {
        this.connect();
      }
    }, delay);
    this.reconnectTimer.unref?.();
  }
}
