/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * server/Room.js
 * --------------
 * One authoritative match. A Room owns:
 *   - a headless simulation world (the single source of truth),
 *   - two player slots (left / right) each bound to a Connection,
 *   - a per-side input buffer, and
 *   - the snapshot/event fan-out to both clients.
 *
 * The server runs ONE fixed-timestep scheduler (server/index.js) that calls
 * room.fixedStep(dt, now) for every active room, so many matches share one clock
 * and the sim advances in lockstep with wall time regardless of render rate.
 *
 * AUTHORITY MODEL. Clients send INPUT packets (intent only). The Room applies the
 * newest buffered input for each side at the top of its tick, steps the shared
 * simulation, then drains the events the sim produced (hits, points, net cords,
 * game over) and forwards them so clients can play sound / juice / shake locally.
 * The Room NEVER trusts a client for position, score, or hit results — those are
 * computed here and shipped in the snapshot.
 *
 * Phase 2 wires the authoritative loop + snapshots. Lobby concerns (ready flags,
 * host, phase transitions) are represented on the Room but driven in Phase 3/9.
 */
'use strict';

const Protocol = require('../shared/protocol.js');
const C = require('../shared/constants.js');
const Sim = require('../shared/simulation.js');
const { buildSnapshot } = require('../shared/snapshot.js');

// How often the world is broadcast, expressed as "emit a snapshot every N ticks".
const SNAPSHOT_EVERY = Math.max(1, Math.round(Protocol.TICK_RATE / Protocol.SNAPSHOT_RATE));

// Phase 8: bounded per-tick input queue (was a single "newest wins" slot through
// Phase 7 — see the old comment on queueInput below, now out of date). The client
// now sends exactly one INPUT per its own fixed-tick prediction step and replays
// its own local buffer on reconciliation (index.html), so for that replay to ever
// converge with what actually happened here, the server must apply the SAME
// sequence of commands the client predicted with — never silently coalesce two
// ticks' worth of intent into one by keeping only the latest. We still cap the
// queue so a client that's fallen behind (tab backgrounded, bad connection) can't
// buy itself an ever-growing input backlog and replay a huge burst of stale
// movement all at once when it catches up; a few ticks of slack (~a snapshot
// interval) is enough to smooth normal jitter without letting latency creep.
const MAX_QUEUED_INPUTS = 6;

class Slot {
  constructor(side) {
    this.side = side;         // 'left' | 'right'
    this.conn = null;         // bound Connection, or null when empty
    this.ready = false;
    this.character = null;    // chosen character object
    this.lastSeq = 0;         // highest input seq applied (sent back as ackSeq)
    this.queue = [];          // FIFO of un-applied input commands, oldest first
    this.connected = true;    // false while a bound player is temporarily gone (Phase 10)
  }
  get occupied() { return !!this.conn; }
}

class Room {
  constructor(code, manager) {
    this.code = code;
    this.manager = manager;
    this.phase = Protocol.PHASE.LOBBY;
    this.hostId = null;                 // clientId of the host (room creator)
    this.left = new Slot('left');
    this.right = new Slot('right');
    this.world = null;                  // created on match start
    this.tick = 0;
    this._sinceSnapshot = 0;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();     // for idle-room TTL (Phase 4)
    this.bg = 'classic';
  }

  // ---- slot helpers ------------------------------------------------------
  slotFor(side) { return side === 'left' ? this.left : this.right; }
  slotForConn(conn) {
    if (this.left.conn === conn) return this.left;
    if (this.right.conn === conn) return this.right;
    return null;
  }
  sideForConn(conn) {
    if (this.left.conn === conn) return 'left';
    if (this.right.conn === conn) return 'right';
    return null;
  }
  get playerCount() { return (this.left.occupied ? 1 : 0) + (this.right.occupied ? 1 : 0); }
  get isEmpty() { return this.playerCount === 0; }

  /** Seat a connection into the first free slot. Returns the side, or null if full. */
  seat(conn, isHost) {
    let slot = !this.left.occupied ? this.left : (!this.right.occupied ? this.right : null);
    if (!slot) return null;
    slot.conn = conn;
    slot.connected = true;
    slot.ready = false;
    slot.character = slot.character || C.CHARACTERS[slot.side === 'left' ? 0 : 1];
    conn.room = this;
    if (isHost || this.hostId === null) this.hostId = conn.id;
    this.touch();
    return slot.side;
  }

  /** Remove a connection from its slot. Returns the freed side, or null. */
  unseat(conn) {
    const side = this.sideForConn(conn);
    if (!side) return null;
    const slot = this.slotFor(side);
    slot.conn = null;
    slot.ready = false;
    slot.queue.length = 0;
    if (conn.room === this) conn.room = null;
    // Host migration: if the host left and someone remains, promote them.
    if (this.hostId === conn.id) {
      const other = side === 'left' ? this.right : this.left;
      this.hostId = other.occupied ? other.conn.id : null;
    }
    this.touch();
    return side;
  }

  touch() { this.lastActivity = Date.now(); }

  // ---- input -------------------------------------------------------------
  /**
   * Buffer an input command from a client, FIFO, one command per authoritative
   * tick (Phase 8). A late/duplicate/out-of-order packet (seq no greater than
   * one already applied OR already queued) is dropped — reordering can't rewind
   * a player. The queue is capped at MAX_QUEUED_INPUTS: if a client is sending
   * faster than we're draining (shouldn't happen in steady state, since the
   * client's own prediction loop sends at the same TICK_RATE — see index.html
   * stepOnlinePrediction — but a stall/hiccup can momentarily burst), we drop
   * the OLDEST excess rather than let the backlog grow, trading a little
   * dropped history for bounded latency.
   */
  queueInput(conn, cmd) {
    const slot = this.slotForConn(conn);
    if (!slot) return;
    if (typeof cmd.seq === 'number' && cmd.seq <= slot.lastSeq) return; // stale/duplicate
    const queue = slot.queue;
    const newestQueued = queue.length ? queue[queue.length - 1] : null;
    if (newestQueued && typeof cmd.seq === 'number' && typeof newestQueued.seq === 'number' &&
        cmd.seq <= newestQueued.seq) return; // out of order relative to what's already buffered
    queue.push(cmd);
    while (queue.length > MAX_QUEUED_INPUTS) queue.shift();
    this.touch();
  }

  // Apply exactly one buffered input command (the oldest) this tick — translates
  // it into the same sim calls a keypress used to make. If the queue is empty
  // (a dropped packet, or the client briefly fell behind sending), we simply
  // don't touch inLeft/inRight/etc. this tick: the player keeps doing whatever
  // it was last told to, rather than snapping to a stop, so one missed packet
  // reads as a tiny hitch instead of a stutter.
  _applyInput(slot, now) {
    const cmd = slot.queue.shift();
    if (!cmd) return;
    const p = this.world[slot.side];

    // held movement
    p.inLeft = !!cmd.left;
    p.inRight = !!cmd.right;

    // edge actions (each INPUT packet represents one tick of intent)
    if (cmd.jump) Sim.tryJump(this.world, p);
    if (cmd.dash === 1 || cmd.dash === -1) Sim.applyDash(this.world, p, cmd.dash, now);

    // charge is a held button: rising edge -> startCharge, falling edge -> releaseHit
    if (cmd.charge && !p.charging) Sim.startCharge(this.world, p, now);
    else if (!cmd.charge && p.charging) Sim.releaseHit(this.world, p, now);

    if (typeof cmd.seq === 'number') slot.lastSeq = cmd.seq;
  }

  // ---- match lifecycle ---------------------------------------------------
  startMatch() {
    this.world = Sim.createWorld(this.left.character, this.right.character);
    this.tick = 0;
    this._sinceSnapshot = 0;
    this.phase = Protocol.PHASE.PLAYING;
    this.touch();
  }

  // ---- fixed-step tick (called by the server scheduler) ------------------
  /**
   * Advance this room one authoritative step. `now` is monotonic seconds.
   * Returns an array of outbound packets ({ toSide|broadcast, packet }) for the
   * server to send — keeps Room transport-agnostic and easy to unit test.
   */
  fixedStep(dt, now) {
    const out = [];
    if (this.phase !== Protocol.PHASE.PLAYING || !this.world) return out;

    // 1) apply newest input for each side
    this._applyInput(this.left, now);
    this._applyInput(this.right, now);

    // 2) advance the authoritative world
    Sim.stepWorld(this.world, dt, now);
    this.tick++;

    // 3) forward simulation events (hits, points, net, game over) to both clients
    if (this.world.events.length) {
      for (const ev of this.world.events) {
        out.push({ broadcast: true, packet: { type: Protocol.S2C.EVENT, kind: mapEventKind(ev), data: ev } });
        if (ev.kind === 'gameOver') this.phase = Protocol.PHASE.GAME_OVER;
      }
      this.world.events.length = 0;
    }

    // 4) broadcast a snapshot at the snapshot cadence
    this._sinceSnapshot++;
    if (this._sinceSnapshot >= SNAPSHOT_EVERY) {
      this._sinceSnapshot = 0;
      const snap = buildSnapshot(this.world, this.tick, Date.now(), {
        left: this.left.lastSeq, right: this.right.lastSeq
      });
      out.push({ broadcast: true, packet: Object.assign({ type: Protocol.S2C.SNAPSHOT }, snap) });
    }

    return out;
  }

  // ---- lobby state (mirrored to clients) ---------------------------------
  lobbyState() {
    const slotInfo = (slot) => ({
      side: slot.side,
      occupied: slot.occupied,
      name: slot.conn ? slot.conn.name : null,
      clientId: slot.conn ? slot.conn.id : null,
      ready: slot.ready,
      connected: slot.connected,
      isHost: slot.conn ? slot.conn.id === this.hostId : false,
      character: slot.character ? slot.character.id : null
    });
    return {
      type: Protocol.S2C.LOBBY_STATE,
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      bg: this.bg,
      players: [slotInfo(this.left), slotInfo(this.right)]
    };
  }
}

// Map an internal sim event to the coarse Protocol.EVENT kind the client keys off.
function mapEventKind(ev) {
  switch (ev.kind) {
    case 'point': return Protocol.EVENT.POINT;
    case 'serve': return Protocol.EVENT.SERVE;
    case 'gameOver': return Protocol.EVENT.GAME_OVER;
    case 'shake': return Protocol.EVENT.SHAKE;
    case 'hit': return Protocol.EVENT.HIT;
    default: return ev.kind; // 'net', 'land' pass through for client juice
  }
}

module.exports = { Room, Slot, MAX_QUEUED_INPUTS };
