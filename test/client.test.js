import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WledClient } from '../src/wled/client.js';
import { FIXTURES, createController, createFakeWled } from './helpers/fakeWled.js';

const reply = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    if (body instanceof Error) {
      throw body;
    }
    return body;
  },
});

test('getStateInfo reads /json/si, and /json on builds without it', async () => {
  const recent = createController(FIXTURES.rgb0154);
  const old = createController(FIXTURES.rgbMinimal, { noSi: true });
  const network = createFakeWled([recent, old]);

  const a = await new WledClient(recent.host, { fetch: network.fetch }).getStateInfo();
  assert.equal(a.info.ver, '0.15.4');
  assert.deepEqual(
    recent.requests.map((r) => r.path),
    ['/json/si'],
  );

  const b = await new WledClient(old.host, { fetch: network.fetch }).getStateInfo();
  assert.equal(b.info.ver, '0.14.0');
  assert.ok(b.state.seg);
  assert.deepEqual(
    old.requests.map((r) => r.path),
    ['/json/si', '/json'],
  );
});

test('a device that is not WLED is refused', async () => {
  const client = new WledClient('192.0.2.99', { fetch: async () => reply(200, { hello: 1 }) });
  await assert.rejects(client.getStateInfo(), /did not answer like a WLED controller/);
});

test('network errors and timeouts are flagged unreachable, HTTP errors are not', async () => {
  const down = new WledClient('192.0.2.98', {
    fetch: async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    },
  });
  await assert.rejects(
    down.getStateInfo(),
    (err) => err.unreachable && /ECONNREFUSED/.test(err.message),
  );

  const slow = new WledClient('192.0.2.97', {
    timeoutMs: 20,
    fetch: (url, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason));
      }),
  });
  // AbortSignal.timeout does not keep the event loop alive (the SDK socket
  // does, in the container): hold it while waiting.
  const keepAlive = setTimeout(() => {}, 1000);
  await assert.rejects(slow.getEffects(), (err) => err.unreachable && /timeout/.test(err.message));
  clearTimeout(keepAlive);

  const broken = new WledClient('192.0.2.96', { fetch: async () => reply(500, {}) });
  await assert.rejects(broken.getEffects(), (err) => !err.unreachable && err.status === 500);

  const garbage = new WledClient('192.0.2.95', {
    fetch: async () => reply(200, new SyntaxError('bad')),
  });
  await assert.rejects(garbage.getPalettes(), /invalid JSON/);
});

test('a missing or broken presets file reads as no presets', async () => {
  const missing = new WledClient('192.0.2.94', { fetch: async () => reply(404, {}) });
  assert.deepEqual(await missing.getPresets(), {});
  const broken = new WledClient('192.0.2.93', {
    fetch: async () => reply(200, new SyntaxError('cut')),
  });
  assert.deepEqual(await broken.getPresets(), {});
  const list = new WledClient('192.0.2.92', { fetch: async () => reply(200, [1, 2]) });
  assert.deepEqual(await list.getPresets(), {});
  const down = new WledClient('192.0.2.91', {
    fetch: async () => {
      throw new TypeError('fetch failed');
    },
  });
  await assert.rejects(down.getPresets(), (err) => err.unreachable);
});

test('setState posts JSON with v: true and resolves with the new state', async () => {
  const controller = createController(FIXTURES.rgb0154);
  const network = createFakeWled([controller]);
  const client = new WledClient(controller.host, { fetch: network.fetch });
  const state = await client.setState({ on: false });
  assert.deepEqual(controller.posts, [{ on: false, v: true }]);
  assert.equal(state.on, false);
});

test('requests to one controller are sent one at a time, a failure does not block the next', async () => {
  let running = 0;
  let maxRunning = 0;
  let calls = 0;
  const client = new WledClient('192.0.2.90', {
    fetch: async () => {
      calls += 1;
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      if (calls === 2) {
        throw new TypeError('fetch failed');
      }
      return reply(200, []);
    },
  });
  const results = await Promise.allSettled([
    client.getEffects(),
    client.getEffects(),
    client.getEffects(),
  ]);
  assert.equal(maxRunning, 1);
  assert.deepEqual(
    results.map((r) => r.status),
    ['fulfilled', 'rejected', 'fulfilled'],
  );
  assert.equal(client.websocketUrl, 'ws://192.0.2.90/ws');
});
