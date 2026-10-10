import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveSocket } from '../src/wled/socket.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A scripted WebSocket: the test opens, answers and closes it by hand.
function createScriptedSockets() {
  const sockets = [];
  const factory = (url) => {
    const listeners = {};
    const socket = {
      url,
      sent: [],
      closed: false,
      addEventListener: (type, fn) => (listeners[type] ??= []).push(fn),
      emit: (type, event = {}) => (listeners[type] ?? []).forEach((fn) => fn(event)),
      send: (raw) => socket.sent.push(JSON.parse(raw)),
      close: () => {
        socket.closed = true;
      },
    };
    sockets.push(socket);
    return socket;
  };
  return { sockets, factory };
}

const FAST = { reconnectMinMs: 10, reconnectMaxMs: 40, keepaliveMs: 20, keepaliveTimeoutMs: 10 };

test('documents with a state are delivered, the rest is ignored or re-asked once', async () => {
  const { sockets, factory } = createScriptedSockets();
  const received = [];
  let opened = 0;
  const live = new LiveSocket({
    url: 'ws://192.0.2.10/ws',
    createSocket: factory,
    timings: { ...FAST, keepaliveMs: 10_000 },
    onMessage: (data) => received.push(data),
    onOpen: () => {
      opened += 1;
    },
  });
  live.start();
  const [socket] = sockets;
  assert.equal(socket.url, 'ws://192.0.2.10/ws');
  socket.emit('open');
  assert.equal(opened, 1);
  assert.equal(live.connected, true);

  socket.emit('message', { data: JSON.stringify({ state: { on: true }, info: { ver: 'x' } }) });
  socket.emit('message', { data: 'not json' });
  socket.emit('message', { data: new Uint8Array([1, 2]) });
  // Busy controller: asked again once, not twice.
  socket.emit('message', { data: JSON.stringify({ error: 3 }) });
  socket.emit('message', { data: JSON.stringify({ error: 3 }) });
  assert.deepEqual(socket.sent, [{ v: true }]);
  socket.emit('message', { data: JSON.stringify({ state: { on: false } }) });
  socket.emit('message', { data: JSON.stringify({ error: 3 }) });
  assert.deepEqual(socket.sent, [{ v: true }, { v: true }]);
  assert.deepEqual(
    received.map((d) => d.state.on),
    [true, false],
  );
  live.stop();
  assert.equal(socket.closed, true);
});

test('a lost connection is retried with a growing delay, until stopped', async () => {
  const { sockets, factory } = createScriptedSockets();
  let closes = 0;
  const live = new LiveSocket({
    url: 'ws://192.0.2.10/ws',
    createSocket: factory,
    timings: FAST,
    onMessage: () => {},
    onClose: () => {
      closes += 1;
    },
  });
  live.start();
  sockets[0].emit('open');
  sockets[0].emit('close');
  assert.equal(closes, 1);
  assert.equal(live.connected, false);
  await wait(15);
  assert.equal(sockets.length, 2, 'reconnected after the first delay');
  // The new attempt fails before opening: no onClose (it was never open).
  sockets[1].emit('error');
  assert.equal(closes, 1);
  await wait(12);
  assert.equal(sockets.length, 2, 'the second delay is longer');
  await wait(15);
  assert.equal(sockets.length, 3);
  // An open connection resets the delay.
  sockets[2].emit('open');
  assert.equal(live.delay, FAST.reconnectMinMs);
  live.stop();
  await wait(50);
  assert.equal(sockets.length, 3, 'no reconnection once stopped');
});

test('a silent connection is closed after the keepalive gets no answer', async () => {
  const { sockets, factory } = createScriptedSockets();
  let closes = 0;
  const live = new LiveSocket({
    url: 'ws://192.0.2.10/ws',
    createSocket: factory,
    timings: { ...FAST, reconnectMinMs: 1000 },
    onMessage: () => {},
    onClose: () => {
      closes += 1;
    },
  });
  live.start();
  const [socket] = sockets;
  socket.emit('open');
  await wait(25);
  assert.deepEqual(socket.sent, [{ v: true }], 'asked for the state');
  // An answer arrives in time: still open.
  socket.emit('message', { data: JSON.stringify({ state: {} }) });
  await wait(5);
  assert.equal(live.connected, true);
  // Next ping, no answer.
  await wait(40);
  assert.equal(live.connected, false);
  assert.equal(socket.closed, true);
  assert.equal(closes, 1);
  live.stop();
});

test('a socket that cannot even be created is retried', async () => {
  let attempts = 0;
  const live = new LiveSocket({
    url: 'ws://bad host/ws',
    createSocket: () => {
      attempts += 1;
      throw new SyntaxError('Invalid URL');
    },
    timings: FAST,
    onMessage: () => {},
  });
  live.start();
  await wait(15);
  assert.equal(attempts, 2);
  live.stop();
  assert.equal(live.send({ v: true }), false);
});
