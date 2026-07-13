/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * client/net/NetClient.js
 * -----------------------
 * The browser side of the transport. Owns the WebSocket, the HELLO/WELCOME
 * handshake, packet (de)serialization, the ping heartbeat that drives the ping
 * indicator, and a simple event-emitter surface the rest of the client subscribes
 * to. This is the ONLY file in the client that touches a raw socket — lobby UI,
 * prediction, and interpolation all talk to gameplay-shaped events emitted here,
 * so networking never bleeds into gameplay code.
 *
 * Usage:
 *   const net = new NetClient();
 *   net.on('welcome', ({ clientId }) => ...);
 *   net.on('pong', () => ...);           // ping measured internally, see .ping
 *   net.on('close', () => ...);
 *   net.connect('Rence');                // opens socket to same host, sends HELLO
 *   net.send(Protocol.C2S.CREATE_LOBBY, { ... });
 *
 * Depends on window.Protocol and window.Serialization (loaded before this file).
 */
(function (root) {
  'use strict';
  var Protocol = root.Protocol;
  var Serialization = root.Serialization;

  // Build the ws:// or wss:// URL for the same origin that served the page, so
  // the socket automatically follows the deployment (localhost in dev, the real
  // domain in production) with no hard-coded address.
  function defaultSocketUrl() {
    var proto = root.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + root.location.host + '/ws';
  }

  function NetClient(url) {
    this.url = url || defaultSocketUrl();
    this.socket = null;
    this.clientId = null;
    this.name = 'Player';
    this.connected = false;
    this.ping = 0;                 // last measured round-trip time (ms)
    this._listeners = {};          // event -> [handlers]
    this._pingTimer = null;
    this._reconnect = { attempts: 0, max: 5, timer: null, wanted: false };
  }

  // ---- tiny event emitter -------------------------------------------------
  NetClient.prototype.on = function (event, handler) {
    (this._listeners[event] || (this._listeners[event] = [])).push(handler);
    return this;
  };
  NetClient.prototype.off = function (event, handler) {
    var arr = this._listeners[event];
    if (!arr) return this;
    this._listeners[event] = arr.filter(function (h) { return h !== handler; });
    return this;
  };
  NetClient.prototype._emit = function (event, payload) {
    var arr = this._listeners[event];
    if (arr) for (var i = 0; i < arr.length; i++) arr[i](payload);
  };

  // ---- connection lifecycle ----------------------------------------------
  /**
   * Open the socket and, once it's up, send HELLO. Emits 'connecting' now and
   * 'open' / 'welcome' / 'close' / 'error' as the handshake proceeds.
   */
  NetClient.prototype.connect = function (name) {
    if (name) this.name = name;
    this._reconnect.wanted = true;
    this._open();
    return this;
  };

  NetClient.prototype._open = function () {
    var self = this;
    this._emit('connecting', { attempt: this._reconnect.attempts });
    var socket;
    try {
      socket = new WebSocket(this.url);
    } catch (e) {
      this._emit('error', { message: 'Failed to open socket' });
      this._scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = function () {
      self.connected = true;
      self._reconnect.attempts = 0;
      self._emit('open', {});
      // Announce ourselves; server replies WELCOME with our clientId.
      self.send(Protocol.C2S.HELLO, { name: self.name });
      self._startPing();
    };

    socket.onmessage = function (ev) {
      var packet = Serialization.decode(ev.data);
      if (!packet) return;
      self._route(packet);
    };

    socket.onclose = function () {
      self.connected = false;
      self._stopPing();
      self._emit('close', {});
      if (self._reconnect.wanted) self._scheduleReconnect();
    };

    socket.onerror = function () {
      self._emit('error', { message: 'Socket error' });
      // onclose fires right after; reconnect is handled there.
    };
  };

  /** Deliberate user-initiated disconnect — stops reconnect attempts. */
  NetClient.prototype.disconnect = function () {
    this._reconnect.wanted = false;
    if (this._reconnect.timer) { clearTimeout(this._reconnect.timer); this._reconnect.timer = null; }
    this._stopPing();
    if (this.socket) { try { this.socket.close(); } catch (_e) {} }
  };

  // Exponential-ish backoff, capped. Emits 'reconnecting' / 'reconnectFailed'
  // so the UI can show a spinner or a "Reconnect" button (Phase 10 wires those).
  NetClient.prototype._scheduleReconnect = function () {
    var self = this;
    if (!this._reconnect.wanted) return;
    if (this._reconnect.attempts >= this._reconnect.max) {
      this._emit('reconnectFailed', {});
      return;
    }
    this._reconnect.attempts++;
    var delay = Math.min(500 * Math.pow(2, this._reconnect.attempts - 1), 8000);
    this._emit('reconnecting', { attempt: this._reconnect.attempts, delay: delay });
    this._reconnect.timer = setTimeout(function () { self._open(); }, delay);
  };

  // ---- send / route -------------------------------------------------------
  /** Send a typed packet. `type` is a Protocol.C2S.* value; fields are merged in. */
  NetClient.prototype.send = function (type, fields) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    var packet = { type: type };
    if (fields) for (var k in fields) if (fields.hasOwnProperty(k)) packet[k] = fields[k];
    this.socket.send(Serialization.encode(packet));
    return true;
  };

  // Turn each server packet into a named event. Handshake/ping are consumed
  // here; everything else is re-emitted under its own type for feature modules.
  NetClient.prototype._route = function (packet) {
    switch (packet.type) {
      case Protocol.S2C.WELCOME:
        this.clientId = packet.clientId;
        this._emit('welcome', packet);
        break;
      case Protocol.S2C.PONG:
        this.ping = Math.max(0, Math.round(performance.now() - packet.t));
        this._emit('pong', { ping: this.ping });
        break;
      default:
        // lobbyState, matchStart, snapshot, event, error, etc.
        this._emit(packet.type, packet);
        break;
    }
    // Also emit a firehose 'packet' event for logging/debugging.
    this._emit('packet', packet);
  };

  // ---- ping heartbeat -----------------------------------------------------
  NetClient.prototype._startPing = function () {
    var self = this;
    this._stopPing();
    var beat = function () { self.send(Protocol.C2S.PING, { t: performance.now() }); };
    beat();
    this._pingTimer = setInterval(beat, Protocol.PING_INTERVAL_MS);
  };
  NetClient.prototype._stopPing = function () {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  };

  root.NetClient = NetClient;
})(typeof self !== 'undefined' ? self : this);
