/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * server/Lobby.js
 * ----------------
 * Phase 3: the waiting-room lifecycle — create, join, leave, pre-match select,
 * ready-up, and host-triggered start. Phase 9 adds REMATCH, which sends a
 * finished match's room back through this exact same ready-up/start flow
 * instead of building a second, parallel "ready system" for it.
 * Every handler here is a pure function of
 * (RoomManager, conn, packet): it mutates Room/RoomManager state and returns a
 * plain description of what happened, but it never touches a socket directly.
 *
 * Return shape, always one of:
 *   { error: { code, message } }             — send this back to the caller only
 *   { room, out: [ { broadcast, packet } ] }  — server/index.js fans these out
 *
 * `conn` only needs `.id`, `.name`, and `.room` to exist — server/index.js's real
 * Connection satisfies that, and so does a plain object in tests, which is what
 * keeps this module honest about not reaching into the transport layer.
 *
 * "Never mix networking code into gameplay unnecessarily" — this file is the
 * lobby's home so that split holds: Room/RoomManager know nothing about packets,
 * server/index.js knows nothing about lobby rules, and this file is the seam
 * between them.
 */
'use strict';

const Protocol = require('../shared/protocol.js');
const C = require('../shared/constants.js');

function err(code, message) { return { error: { code, message } }; }
function lobbyOut(room) { return { room, out: [{ broadcast: true, packet: room.lobbyState() }] }; }

/** CREATE_LOBBY: mint a fresh room (RoomManager owns the unique code, Phase 4) and seat the caller as host. */
function createLobby(roomManager, conn) {
  if (conn.room) return err(Protocol.ERR.ALREADY_IN_ROOM, 'Already in a room.');
  const room = roomManager.createRoom();
  room.seat(conn, /* isHost */ true);
  return lobbyOut(room);
}

/** JOIN_LOBBY: seat the caller into an existing room by code. */
function joinLobby(roomManager, conn, packet) {
  if (conn.room) return err(Protocol.ERR.ALREADY_IN_ROOM, 'Already in a room.');
  const room = roomManager.getRoom(packet && packet.code);
  if (!room) return err(Protocol.ERR.ROOM_NOT_FOUND, 'No room with that code.');
  if (room.phase !== Protocol.PHASE.LOBBY) return err(Protocol.ERR.BAD_STATE, 'That match already started.');
  if (room.playerCount >= 2) return err(Protocol.ERR.ROOM_FULL, 'Room is full.');

  if (typeof packet.name === 'string' && packet.name.trim()) {
    conn.name = packet.name.trim().slice(0, 16);
  }
  room.seat(conn, /* isHost */ false);
  return {
    room,
    out: [
      { broadcast: true, packet: room.lobbyState() },
      { broadcast: true, packet: { type: Protocol.S2C.PLAYER_JOINED, clientId: conn.id, name: conn.name } }
    ]
  };
}

/** LEAVE_LOBBY: free the caller's slot. Empties out immediately if the room is now unoccupied. */
function leaveLobby(roomManager, conn) {
  const room = conn.room;
  if (!room) return { room: null, out: [] }; // not in a room — no-op, not an error

  const leftName = conn.name;
  const leftId = conn.id;
  const wasGameOver = room.phase === Protocol.PHASE.GAME_OVER;
  room.unseat(conn);

  if (room.isEmpty) {
    // An explicit leave is unambiguous (unlike a dropped socket), so reclaim
    // the code right away instead of waiting on the Phase 4 sweep.
    roomManager.removeRoom(room.code);
    return { room, out: [] };
  }

  // Phase 9: if the room was sitting on a finished match's victory screen and
  // one side leaves before anyone requests a rematch, hand the remaining
  // player back to a fresh LOBBY instead of leaving them stuck in a
  // GAME_OVER room that JOIN_LOBBY will never let a new player into (and that
  // the Phase 4 sweep deliberately never reclaims — see RoomManager.sweep).
  if (wasGameOver) {
    room.phase = Protocol.PHASE.LOBBY;
    room.world = null;
    room.left.ready = false;
    room.right.ready = false;
  }

  return {
    room,
    out: [
      { broadcast: true, packet: room.lobbyState() },
      { broadcast: true, packet: { type: Protocol.S2C.PLAYER_LEFT, clientId: leftId, name: leftName } }
    ]
  };
}

/** SELECT: pre-match character/background choice. Ignored once a match is running. */
function select(conn, packet) {
  const room = conn.room;
  const slot = room && room.slotForConn(conn);
  if (!slot) return err(Protocol.ERR.BAD_STATE, 'Not seated in a room.');
  if (room.phase !== Protocol.PHASE.LOBBY) return { room, out: [] };

  if (packet && packet.character) {
    const chosen = C.CHARACTERS.find((ch) => ch.id === packet.character);
    if (chosen) slot.character = chosen;
  }
  if (packet && typeof packet.bg === 'string') room.bg = packet.bg;
  room.touch();
  return lobbyOut(room);
}

/** READY: toggle this player's ready flag for the waiting room. */
function ready(conn, packet) {
  const room = conn.room;
  const slot = room && room.slotForConn(conn);
  if (!slot) return err(Protocol.ERR.BAD_STATE, 'Not seated in a room.');
  slot.ready = !!(packet && packet.ready);
  room.touch();
  return lobbyOut(room);
}

/** START_MATCH: host-only. Requires two seated, both-ready players in LOBBY phase. */
function startMatch(conn) {
  const room = conn.room;
  if (!room) return err(Protocol.ERR.BAD_STATE, 'Not in a room.');
  if (room.hostId !== conn.id) return err(Protocol.ERR.NOT_HOST, 'Only the host can start the match.');
  if (room.phase !== Protocol.PHASE.LOBBY) return err(Protocol.ERR.BAD_STATE, 'Match already started.');
  if (room.playerCount < 2) return err(Protocol.ERR.BAD_STATE, 'Waiting for a second player.');
  if (!room.left.ready || !room.right.ready) return err(Protocol.ERR.BAD_STATE, 'Both players must be ready.');

  room.startMatch();
  return {
    room,
    out: [{
      broadcast: true,
      packet: {
        type: Protocol.S2C.MATCH_START,
        leftId: room.left.conn.id,
        rightId: room.right.conn.id,
        matchup: { left: room.left.character.id, right: room.right.character.id },
        bg: room.bg
      }
    }]
  };
}

/**
 * REMATCH: requested from the victory screen. Deliberately reuses the exact
 * same ready-up/START_MATCH machinery Phase 3 already built for the very
 * first match, rather than inventing a parallel "ready system" — a rematch
 * IS just another trip through the waiting room:
 *
 *   victory screen --REMATCH--> LOBBY (both ready flags cleared, world
 *   dropped) --READY/REMATCH x2--> host presses START_MATCH --> fresh world.
 *
 * The first REMATCH from either side (while phase is still GAME_OVER) flips
 * the room back to LOBBY and marks the sender ready; a second REMATCH (or a
 * plain READY toggle — either works once phase is LOBBY) marks the other
 * side. Nothing here talks to a socket directly — see the module banner.
 */
function rematch(conn) {
  const room = conn.room;
  const slot = room && room.slotForConn(conn);
  if (!slot) return err(Protocol.ERR.BAD_STATE, 'Not seated in a room.');

  if (room.phase === Protocol.PHASE.GAME_OVER) {
    room.phase = Protocol.PHASE.LOBBY;
    room.world = null;
    room.left.ready = false;
    room.right.ready = false;
  } else if (room.phase !== Protocol.PHASE.LOBBY) {
    // Mid-match (PLAYING/COUNTDOWN) — a rematch only makes sense once the
    // current match has actually ended.
    return err(Protocol.ERR.BAD_STATE, 'No finished match to rematch.');
  }

  slot.ready = true;
  room.touch();
  return lobbyOut(room);
}

module.exports = { createLobby, joinLobby, leaveLobby, select, ready, startMatch, rematch };
