/**
 * Phase 9 unit test: REMATCH — the victory-screen "ready system" that sends a
 * finished room back through the same LOBBY/READY/START_MATCH flow Phase 3
 * built for the very first match. Runs against fake connections (plain
 * objects with id/name/room), same pattern as test-phase3.js — no real
 * WebSocket needed.
 * Run: node server/test-phase9.js
 */
'use strict';
const assert = require('assert');
const Protocol = require('../shared/protocol.js');
const { RoomManager } = require('./RoomManager.js');
const Lobby = require('./Lobby.js');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('PASS:', name); }
  catch (e) { failures++; console.log('FAIL:', name, '-', e.message); }
}

let nextId = 1;
function fakeConn(name) { return { id: nextId++, name: name || 'Player', room: null, send() {} }; }

// Seats host+guest, readies both, and starts a match — the state every
// REMATCH test starts from.
function setUpFinishedMatch(mgr) {
  const host = fakeConn('Host'), guest = fakeConn('Guest');
  const created = Lobby.createLobby(mgr, host);
  Lobby.joinLobby(mgr, guest, { code: created.room.code });
  Lobby.ready(host, { ready: true });
  Lobby.ready(guest, { ready: true });
  Lobby.startMatch(host);
  const room = created.room;
  assert.strictEqual(room.phase, Protocol.PHASE.PLAYING, 'sanity: match actually started');
  // Simulate the match ending the way Room.fixedStep does on a 'gameOver' event.
  room.phase = Protocol.PHASE.GAME_OVER;
  return { mgr, room, host, guest };
}

check('REMATCH from either side after GAME_OVER sends the room back to LOBBY, ready', () => {
  const { room, host } = setUpFinishedMatch(new RoomManager());
  const res = Lobby.rematch(host);
  assert.ok(!res.error);
  assert.strictEqual(room.phase, Protocol.PHASE.LOBBY, 'first REMATCH flips GAME_OVER -> LOBBY');
  assert.strictEqual(room.world, null, 'the finished match world is dropped');
  assert.strictEqual(room.left.ready, true, 'the requester is marked ready');
  assert.strictEqual(room.right.ready, false, 'the other side is NOT auto-readied');
  assert.strictEqual(res.out[0].packet.type, Protocol.S2C.LOBBY_STATE);
});

check('a second REMATCH (the other side) readies them too, without re-clearing the first', () => {
  const { room, host, guest } = setUpFinishedMatch(new RoomManager());
  Lobby.rematch(host);
  const res = Lobby.rematch(guest);
  assert.ok(!res.error);
  assert.strictEqual(room.left.ready, true, 'host stays ready from the first request');
  assert.strictEqual(room.right.ready, true, 'guest is now ready too');
});

check('plain READY also works once REMATCH has flipped the room back to LOBBY', () => {
  const { room, host, guest } = setUpFinishedMatch(new RoomManager());
  Lobby.rematch(host);
  const res = Lobby.ready(guest, { ready: true });
  assert.ok(!res.error);
  assert.strictEqual(room.right.ready, true);
});

check('START_MATCH after both REMATCH begins a fresh match (new world, PLAYING)', () => {
  const { room, host, guest } = setUpFinishedMatch(new RoomManager());
  const oldWorld = room.world; // already null post-GAME_OVER simulation, but assert the identity changes below
  Lobby.rematch(host);
  Lobby.rematch(guest);
  const res = Lobby.startMatch(host);
  assert.ok(!res.error);
  assert.strictEqual(room.phase, Protocol.PHASE.PLAYING);
  assert.notStrictEqual(room.world, oldWorld);
  assert.ok(room.world, 'a fresh world was created for the rematch');
  assert.strictEqual(room.world.left.score, 0, 'scores reset for the new match');
  assert.strictEqual(res.out[0].packet.type, Protocol.S2C.MATCH_START);
});

check('REMATCH is rejected mid-match (before GAME_OVER)', () => {
  const mgr = new RoomManager();
  const host = fakeConn('Host'), guest = fakeConn('Guest');
  const created = Lobby.createLobby(mgr, host);
  Lobby.joinLobby(mgr, guest, { code: created.room.code });
  Lobby.ready(host, { ready: true });
  Lobby.ready(guest, { ready: true });
  Lobby.startMatch(host);
  assert.strictEqual(created.room.phase, Protocol.PHASE.PLAYING);
  const res = Lobby.rematch(host);
  assert.strictEqual(res.error.code, Protocol.ERR.BAD_STATE);
});

check('REMATCH rejects an unseated connection', () => {
  const res = Lobby.rematch(fakeConn('Nobody'));
  assert.strictEqual(res.error.code, Protocol.ERR.BAD_STATE);
});

check('LEAVE_LOBBY while GAME_OVER hands the remaining player back to a fresh LOBBY', () => {
  const mgr = new RoomManager();
  const { room, host, guest } = setUpFinishedMatch(mgr);
  const res = Lobby.leaveLobby(mgr, guest);
  assert.strictEqual(res.room, room);
  assert.strictEqual(room.isEmpty, false, 'host is still seated');
  assert.strictEqual(room.phase, Protocol.PHASE.LOBBY, 'reclaimed from GAME_OVER so the room is joinable again');
  assert.strictEqual(room.left.ready, false);
  assert.strictEqual(room.right.ready, false);
  // And the room really is joinable again (this is the whole point of the fix —
  // JOIN_LOBBY refuses anything that isn't phase LOBBY).
  const third = fakeConn('Third');
  const joinRes = Lobby.joinLobby(mgr, third, { code: room.code });
  assert.ok(!joinRes.error, 'a new player can join the reclaimed lobby');
});

check('LEAVE_LOBBY while GAME_OVER and both leave still frees the room code as normal', () => {
  const mgr = new RoomManager();
  const { room, host, guest } = setUpFinishedMatch(mgr);
  Lobby.leaveLobby(mgr, guest);
  const res = Lobby.leaveLobby(mgr, host);
  assert.strictEqual(res.room.isEmpty, true);
  assert.strictEqual(mgr.getRoom(room.code), null, 'empty room reclaimed immediately, same as any other empty-out');
});

check('LEAVE_LOBBY mid-match (PLAYING) does NOT force phase back to LOBBY (Phase 10\'s job, not Phase 9\'s)', () => {
  const mgr = new RoomManager();
  const host = fakeConn('Host'), guest = fakeConn('Guest');
  const created = Lobby.createLobby(mgr, host);
  Lobby.joinLobby(mgr, guest, { code: created.room.code });
  Lobby.ready(host, { ready: true });
  Lobby.ready(guest, { ready: true });
  Lobby.startMatch(host);
  assert.strictEqual(created.room.phase, Protocol.PHASE.PLAYING);
  Lobby.leaveLobby(mgr, guest);
  assert.strictEqual(created.room.phase, Protocol.PHASE.PLAYING, 'unrelated to the GAME_OVER-specific Phase 9 fix');
});

console.log(failures === 0 ? '\nALL PASS (Phase 9: ready system / rematch)' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
