/**
 * Phase 8 unit test: client-side prediction & reconciliation groundwork.
 *
 * Two things need to hold for prediction to ever converge instead of jittering
 * every snapshot:
 *   1. The server must apply the client's inputs ONE PER TICK, IN ORDER (a
 *      bounded FIFO, not "keep only the newest" — Phase 7's behavior) so a
 *      client replaying its own unacked inputs on top of a corrected baseline
 *      reconstructs the same sequence of steps the server actually took.
 *   2. The movement math itself (Sim.updatePlayer) must be byte-for-byte the
 *      SAME function on both ends, so replaying it client-side against a
 *      server-authoritative baseline reproduces the server's position exactly
 *      when the network is lossless — any remaining correction is then purely
 *      down to latency, not a physics disagreement.
 *
 * Runs against fake connections (plain objects, no real WebSocket) exactly like
 * test-phase3.js/test-phase4.js — exercises Room.js directly.
 * Run: node server/test-phase8.js
 */
'use strict';
const assert = require('assert');
const C = require('../shared/constants.js');
const Sim = require('../shared/simulation.js');
const { Room, MAX_QUEUED_INPUTS } = require('./Room.js');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('PASS:', name); }
  catch (e) { failures++; console.log('FAIL:', name, '-', e.message); }
}

let nextId = 1;
function fakeConn(name) { return { id: nextId++, name: name || 'Player', room: null, send() {} }; }

function freshPlayingRoom() {
  const room = new Room('TEST8', null);
  const a = fakeConn('A'), b = fakeConn('B');
  room.seat(a, true);
  room.seat(b, false);
  room.left.character = C.CHARACTERS[0];
  room.right.character = C.CHARACTERS[1];
  room.startMatch();
  room.world.state = 'rally'; // skip serve handshake — irrelevant to movement math
  room.world.shuttle.active = false;
  return room;
}

check('queueInput + fixedStep applies exactly ONE buffered command per tick, in FIFO order', () => {
  const room = freshPlayingRoom();
  room.queueInput(room.left.conn, { seq: 1, left: true, right: false });
  room.queueInput(room.left.conn, { seq: 2, left: false, right: true });
  room.queueInput(room.left.conn, { seq: 3, left: true, right: false });
  assert.strictEqual(room.left.queue.length, 3, 'all three commands buffered before any tick runs');

  room.fixedStep(1 / 60, 0);
  assert.strictEqual(room.left.lastSeq, 1);
  assert.strictEqual(room.world.left.inLeft, true);
  assert.strictEqual(room.world.left.inRight, false);
  assert.strictEqual(room.left.queue.length, 2, 'the other two are still queued, not dropped');

  room.fixedStep(1 / 60, 1 / 60);
  assert.strictEqual(room.left.lastSeq, 2);
  assert.strictEqual(room.world.left.inLeft, false);
  assert.strictEqual(room.world.left.inRight, true);

  room.fixedStep(1 / 60, 2 / 60);
  assert.strictEqual(room.left.lastSeq, 3);
  assert.strictEqual(room.world.left.inLeft, true);
  assert.strictEqual(room.world.left.inRight, false);
  assert.strictEqual(room.left.queue.length, 0);
});

check('an empty queue leaves held input untouched instead of snapping to a stop', () => {
  const room = freshPlayingRoom();
  room.queueInput(room.left.conn, { seq: 1, left: true, right: false });
  room.fixedStep(1 / 60, 0); // applies cmd 1 -> moving left
  assert.strictEqual(room.world.left.inLeft, true);
  const xAfterFirstTick = room.world.left.x;

  // No new packet arrives this tick (dropped/late) — player should keep moving
  // left (dead-reckon held state) rather than stop dead.
  room.fixedStep(1 / 60, 1 / 60);
  assert.strictEqual(room.world.left.inLeft, true, 'still moving left with no new packet');
  assert.ok(room.world.left.x < xAfterFirstTick, 'kept moving instead of freezing');
});

check('queue is bounded: sustained backlog drops the OLDEST entries, keeps freshest', () => {
  const room = freshPlayingRoom();
  for (let seq = 1; seq <= MAX_QUEUED_INPUTS + 3; seq++) {
    room.queueInput(room.left.conn, { seq, left: true, right: false });
  }
  assert.strictEqual(room.left.queue.length, MAX_QUEUED_INPUTS);
  assert.strictEqual(room.left.queue[0].seq, 4, 'oldest 3 (seq 1-3) were dropped to stay bounded');
  assert.strictEqual(room.left.queue[room.left.queue.length - 1].seq, MAX_QUEUED_INPUTS + 3);
});

check('stale, duplicate, and out-of-order sequence numbers are rejected', () => {
  const room = freshPlayingRoom();
  room.queueInput(room.left.conn, { seq: 5, left: true, right: false });
  room.queueInput(room.left.conn, { seq: 3, left: false, right: true }); // older than queued -> dropped
  room.queueInput(room.left.conn, { seq: 5, left: false, right: true }); // duplicate -> dropped
  assert.strictEqual(room.left.queue.length, 1);
  assert.strictEqual(room.left.queue[0].seq, 5);

  room.fixedStep(1 / 60, 0); // applies seq 5, lastSeq becomes 5
  room.queueInput(room.left.conn, { seq: 5, left: false, right: true }); // already applied -> dropped
  room.queueInput(room.left.conn, { seq: 2, left: false, right: true }); // way stale -> dropped
  assert.strictEqual(room.left.queue.length, 0);
});

check('ackSeq the server reports matches exactly what it applied (reconciliation contract)', () => {
  const room = freshPlayingRoom();
  room.queueInput(room.left.conn, { seq: 1, left: true, right: false });
  room.queueInput(room.left.conn, { seq: 2, left: true, right: false });
  room.fixedStep(1 / 60, 0);
  assert.strictEqual(room.left.lastSeq, 1);
  room.fixedStep(1 / 60, 1 / 60);
  assert.strictEqual(room.left.lastSeq, 2, 'client can safely discard any pending input with seq <= this');
});

check('client-side replay math (Sim.updatePlayer) reproduces the server position exactly ' +
      'given the identical input sequence and dt — the core prediction guarantee', () => {
  const room = freshPlayingRoom();
  const cmds = [
    { seq: 1, left: true, right: false, jump: true },
    { seq: 2, left: true, right: false },
    { seq: 3, left: false, right: true },
    { seq: 4, left: false, right: true },
    { seq: 5, left: false, right: false },
  ];
  const DT = 1 / 60;
  let now = 0;
  for (const cmd of cmds) {
    room.queueInput(room.left.conn, cmd);
    room.fixedStep(DT, now);
    now += DT;
  }

  // Independently replay the SAME command sequence against a fresh headless
  // world the way index.html's applyPredictedInput() does (movement only —
  // tryJump/applyDash/updatePlayer, never shuttle or hit resolution).
  const shadow = Sim.createWorld(C.CHARACTERS[0], C.CHARACTERS[1]);
  shadow.state = 'rally';
  let t = 0;
  for (const cmd of cmds) {
    const p = shadow.left;
    p.inLeft = !!cmd.left;
    p.inRight = !!cmd.right;
    if (cmd.jump) Sim.tryJump(shadow, p);
    Sim.updatePlayer(shadow, p, DT);
    t += DT;
  }

  assert.strictEqual(shadow.left.x, room.world.left.x, 'predicted x must match authoritative x exactly');
  assert.strictEqual(shadow.left.y, room.world.left.y, 'predicted y must match authoritative y exactly');
  assert.strictEqual(shadow.left.onGround, room.world.left.onGround);
});

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS (Phase 8: client-side prediction & reconciliation)');
process.exit(failures ? 1 : 0);
