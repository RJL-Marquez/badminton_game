/**
 * Phase 3 unit test: the lobby lifecycle (create/join/leave/select/ready/start).
 * Runs against fake connections (plain objects with id/name/room) so it needs
 * no real WebSocket — it exercises Lobby.js + RoomManager + Room exactly the
 * way server/index.js's packet router does, just without the transport.
 * Run: node server/test-phase3.js
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

// Mirrors server/index.js's dispatchLobbyResult, minus the actual socket sends,
// so a test can assert against the same {error|room,out} contract the real
// server acts on.
function applyOut(result) {
  if (result.room) {
    for (const item of result.out) {
      if (item.broadcast) { /* seats already reflect the state; nothing to replay here */ }
    }
  }
  return result;
}

check('CREATE_LOBBY seats the creator as host with a fresh unique code', () => {
  const mgr = new RoomManager();
  const host = fakeConn('Host');
  const res = applyOut(Lobby.createLobby(mgr, host));
  assert.ok(!res.error);
  assert.strictEqual(res.room.hostId, host.id);
  assert.strictEqual(res.room.left.conn, host, 'host takes the first free slot');
  assert.strictEqual(res.room.playerCount, 1);
  assert.strictEqual(mgr.getRoom(res.room.code), res.room);
  assert.strictEqual(res.out[0].packet.type, Protocol.S2C.LOBBY_STATE);
});

check('CREATE_LOBBY refuses a connection that is already seated somewhere', () => {
  const mgr = new RoomManager();
  const host = fakeConn('Host');
  Lobby.createLobby(mgr, host);
  const res = Lobby.createLobby(mgr, host);
  assert.strictEqual(res.error.code, Protocol.ERR.ALREADY_IN_ROOM);
});

check('JOIN_LOBBY seats a second player and both sides see it in lobbyState', () => {
  const mgr = new RoomManager();
  const host = fakeConn('Host');
  const guest = fakeConn('Guest');
  const created = Lobby.createLobby(mgr, host);
  const res = Lobby.joinLobby(mgr, guest, { code: created.room.code, name: 'Guest' });
  assert.ok(!res.error);
  assert.strictEqual(res.room.right.conn, guest);
  assert.strictEqual(res.room.playerCount, 2);
  const lobbyPacket = res.out.find((o) => o.packet.type === Protocol.S2C.LOBBY_STATE).packet;
  assert.strictEqual(lobbyPacket.players.length, 2);
  const joinedPacket = res.out.find((o) => o.packet.type === Protocol.S2C.PLAYER_JOINED);
  assert.ok(joinedPacket, 'should announce the join separately from the state snapshot');
});

check('JOIN_LOBBY is case-insensitive / whitespace-tolerant on the code', () => {
  const mgr = new RoomManager();
  const host = fakeConn('Host');
  const guest = fakeConn('Guest');
  const created = Lobby.createLobby(mgr, host);
  const res = Lobby.joinLobby(mgr, guest, { code: '  ' + created.room.code.toLowerCase() + '  ' });
  assert.ok(!res.error);
});

check('JOIN_LOBBY rejects an unknown code', () => {
  const mgr = new RoomManager();
  const guest = fakeConn('Guest');
  const res = Lobby.joinLobby(mgr, guest, { code: 'ZZZZZZ' });
  assert.strictEqual(res.error.code, Protocol.ERR.ROOM_NOT_FOUND);
});

check('JOIN_LOBBY rejects a full room', () => {
  const mgr = new RoomManager();
  const host = fakeConn('Host'), guest = fakeConn('Guest'), third = fakeConn('Third');
  const created = Lobby.createLobby(mgr, host);
  Lobby.joinLobby(mgr, guest, { code: created.room.code });
  const res = Lobby.joinLobby(mgr, third, { code: created.room.code });
  assert.strictEqual(res.error.code, Protocol.ERR.ROOM_FULL);
});

check('JOIN_LOBBY refuses a connection that is already seated somewhere', () => {
  const mgr = new RoomManager();
  const host = fakeConn('Host'), guest = fakeConn('Guest');
  Lobby.createLobby(mgr, host);
  const created2 = Lobby.createLobby(mgr, guest);
  const res = Lobby.joinLobby(mgr, guest, { code: created2.room.code });
  assert.strictEqual(res.error.code, Protocol.ERR.ALREADY_IN_ROOM);
});

check('JOIN_LOBBY refuses to join a match already in progress', () => {
  const mgr = new RoomManager();
  const host = fakeConn('Host'), guest = fakeConn('Guest'), third = fakeConn('Third');
  const created = Lobby.createLobby(mgr, host);
  Lobby.joinLobby(mgr, guest, { code: created.room.code });
  Lobby.ready(host, { ready: true });
  Lobby.ready(guest, { ready: true });
  Lobby.startMatch(host);
  const res = Lobby.joinLobby(mgr, third, { code: created.room.code });
  assert.strictEqual(res.error.code, Protocol.ERR.BAD_STATE);
});

check('READY toggles a slot and START_MATCH requires both ready', () => {
  const mgr = new RoomManager();
  const host = fakeConn('Host'), guest = fakeConn('Guest');
  const created = Lobby.createLobby(mgr, host);
  Lobby.joinLobby(mgr, guest, { code: created.room.code });

  let res = Lobby.startMatch(host);
  assert.strictEqual(res.error.code, Protocol.ERR.BAD_STATE, 'cannot start before anyone is ready');

  Lobby.ready(host, { ready: true });
  res = Lobby.startMatch(host);
  assert.strictEqual(res.error.code, Protocol.ERR.BAD_STATE, 'cannot start until BOTH are ready');

  Lobby.ready(guest, { ready: true });
  res = Lobby.startMatch(host);
  assert.ok(!res.error);
  assert.strictEqual(res.room.phase, Protocol.PHASE.PLAYING);
  assert.strictEqual(res.out[0].packet.type, Protocol.S2C.MATCH_START);
});

check('START_MATCH is host-only', () => {
  const mgr = new RoomManager();
  const host = fakeConn('Host'), guest = fakeConn('Guest');
  const created = Lobby.createLobby(mgr, host);
  Lobby.joinLobby(mgr, guest, { code: created.room.code });
  Lobby.ready(host, { ready: true });
  Lobby.ready(guest, { ready: true });
  const res = Lobby.startMatch(guest);
  assert.strictEqual(res.error.code, Protocol.ERR.NOT_HOST);
});

check('SELECT changes a seated player\'s character and the room background', () => {
  const mgr = new RoomManager();
  const host = fakeConn('Host');
  const created = Lobby.createLobby(mgr, host);
  const res = Lobby.select(host, { character: 'kenji', bg: 'sunset' });
  assert.ok(!res.error);
  assert.strictEqual(res.room.left.character.id, 'kenji');
  assert.strictEqual(res.room.bg, 'sunset');
});

check('SELECT rejects an unseated connection', () => {
  const res = Lobby.select(fakeConn('Nobody'), { character: 'kenji' });
  assert.strictEqual(res.error.code, Protocol.ERR.BAD_STATE);
});

check('LEAVE_LOBBY frees the seat and, when the room empties, frees the code too', () => {
  const mgr = new RoomManager();
  const host = fakeConn('Host');
  const created = Lobby.createLobby(mgr, host);
  const code = created.room.code;
  const res = Lobby.leaveLobby(mgr, host);
  assert.strictEqual(res.room.isEmpty, true);
  assert.strictEqual(mgr.getRoom(code), null, 'empty room should be reclaimed immediately');
});

check('LEAVE_LOBBY promotes the other player to host and keeps the room alive', () => {
  const mgr = new RoomManager();
  const host = fakeConn('Host'), guest = fakeConn('Guest');
  const created = Lobby.createLobby(mgr, host);
  Lobby.joinLobby(mgr, guest, { code: created.room.code });
  const res = Lobby.leaveLobby(mgr, host);
  assert.strictEqual(res.room.isEmpty, false);
  assert.strictEqual(res.room.hostId, guest.id, 'host migration on host departure');
  assert.strictEqual(mgr.getRoom(created.room.code), res.room, 'code stays live with a player still seated');
  const leftPacket = res.out.find((o) => o.packet.type === Protocol.S2C.PLAYER_LEFT);
  assert.ok(leftPacket);
});

check('LEAVE_LOBBY is a safe no-op for a connection not in any room', () => {
  const mgr = new RoomManager();
  const res = Lobby.leaveLobby(mgr, fakeConn('Nobody'));
  assert.strictEqual(res.room, null);
  assert.deepStrictEqual(res.out, []);
});

console.log(failures === 0 ? '\nALL PASS (Phase 3: lobby system)' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
