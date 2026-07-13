// Standalone regression test for the Phase 7 client-side interpolation math
// (lerp / extrapolate / buffer trim logic), extracted to run under plain Node
// without a browser/canvas. Mirrors the functions added to index.html.

const ONLINE_INTERP_DELAY_MS = 100;
const ONLINE_EXTRAPOLATE_MAX_MS = 150;

function lerp(a, b, t) { return a + (b - a) * t; }

function interpEntity(target, a, b, t) {
  target.x = lerp(a.x, b.x, t);
  target.y = lerp(a.y, b.y, t);
  target.vx = lerp(a.vx, b.vx, t);
  target.vy = lerp(a.vy, b.vy, t);
}

function extrapolateEntity(target, sample, aheadSec) {
  target.x = sample.x + sample.vx * aheadSec;
  target.y = sample.y + sample.vy * aheadSec;
  target.vx = sample.vx;
  target.vy = sample.vy;
}

function applyBufferedSample(target, sample) {
  target.x = sample.x; target.y = sample.y; target.vx = sample.vx; target.vy = sample.vy;
}

// Mirrors updateOnlineInterpolation()'s core branch logic for a single entity
// stream (shuttle), given a buffer of {recvTime, shuttle:{x,y,vx,vy}} and a
// "now" in ms.
function computeRender(buf, nowMs) {
  const target = { x: 0, y: 0, vx: 0, vy: 0 };
  if (buf.length === 0) return null;
  const renderTime = nowMs - ONLINE_INTERP_DELAY_MS;

  if (buf.length === 1 || renderTime <= buf[0].recvTime) {
    applyBufferedSample(target, buf[0].shuttle);
    return { mode: 'hold-oldest', target };
  }
  const newest = buf[buf.length - 1];
  if (renderTime >= newest.recvTime) {
    const aheadSec = Math.min(renderTime - newest.recvTime, ONLINE_EXTRAPOLATE_MAX_MS) / 1000;
    extrapolateEntity(target, newest.shuttle, aheadSec);
    return { mode: 'extrapolate', target, aheadSec };
  }
  let i = buf.length - 2;
  while (i > 0 && buf[i].recvTime > renderTime) i--;
  const a = buf[i], b = buf[i + 1];
  const span = b.recvTime - a.recvTime;
  const t = span > 0 ? (renderTime - a.recvTime) / span : 0;
  interpEntity(target, a.shuttle, b.shuttle, t);
  return { mode: 'interpolate', target, i, t };
}

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.log('FAIL:', msg); failures++; }
  else console.log('PASS:', msg);
}
function approx(a, b, eps = 1e-6) { return Math.abs(a - b) < eps; }

// --- Test 1: normal interpolation between two straddling snapshots ---
{
  const buf = [
    { recvTime: 1000, shuttle: { x: 0, y: 0, vx: 100, vy: 0 } },
    { recvTime: 1033, shuttle: { x: 3.3, y: 0, vx: 100, vy: 0 } },
    { recvTime: 1066, shuttle: { x: 6.6, y: 0, vx: 100, vy: 0 } },
    { recvTime: 1100, shuttle: { x: 10, y: 0, vx: 100, vy: 0 } },
  ];
  // now=1150 -> renderTime=1050, falls between recvTime 1033 and 1066
  const r = computeRender(buf, 1150);
  assert(r.mode === 'interpolate', 'normal case picks interpolate mode');
  const expectedT = (1050 - 1033) / (1066 - 1033);
  const expectedX = lerp(3.3, 6.6, expectedT);
  assert(approx(r.target.x, expectedX), 'interpolated x matches manual lerp (' + r.target.x + ' vs ' + expectedX + ')');
}

// --- Test 2: not enough history yet (just connected) ---
{
  const buf = [{ recvTime: 5000, shuttle: { x: 42, y: 7, vx: 0, vy: 0 } }];
  const r = computeRender(buf, 5050); // renderTime=4950, before the only sample
  assert(r.mode === 'hold-oldest', 'single-sample buffer holds at oldest/only sample');
  assert(r.target.x === 42 && r.target.y === 7, 'holds correct position');
}

// --- Test 3: buffer ran dry -> extrapolation within grace window ---
{
  const buf = [
    { recvTime: 2000, shuttle: { x: 0, y: 0, vx: 200, vy: -50 } },
    { recvTime: 2033, shuttle: { x: 6.6, y: -1.6, vx: 200, vy: -50 } },
  ];
  // now = 2033 + 100 (delay) + 60 (stall) = 2193 -> renderTime=2093, 60ms past newest(2033)
  const r = computeRender(buf, 2193);
  assert(r.mode === 'extrapolate', 'dry buffer triggers extrapolation');
  assert(approx(r.aheadSec, 0.06), 'extrapolates by the correct elapsed time (60ms)');
  const expectedX = 6.6 + 200 * 0.06;
  assert(approx(r.target.x, expectedX), 'extrapolated x matches velocity * time (' + r.target.x + ' vs ' + expectedX + ')');
}

// --- Test 4: extrapolation is capped at ONLINE_EXTRAPOLATE_MAX_MS ---
{
  const buf = [
    { recvTime: 2967, shuttle: { x: -6.6, y: 0, vx: 500, vy: 0 } },
    { recvTime: 3000, shuttle: { x: 0, y: 0, vx: 500, vy: 0 } },
  ];
  // stall for a full second -> should clamp to 150ms of extrapolation, not 1000ms+
  const r = computeRender(buf, 3000 + 100 + 1000);
  assert(r.mode === 'extrapolate', 'long stall still uses extrapolate mode');
  assert(approx(r.aheadSec, ONLINE_EXTRAPOLATE_MAX_MS / 1000), 'extrapolation time is clamped to the max grace window');
  assert(approx(r.target.x, 500 * (ONLINE_EXTRAPOLATE_MAX_MS / 1000)), 'clamped extrapolated x is bounded, not runaway');
}

// --- Test 5: monotonic buffer walk-back finds the right pair when render time lands exactly on a sample ---
{
  const buf = [
    { recvTime: 0, shuttle: { x: 0, y: 0, vx: 0, vy: 0 } },
    { recvTime: 33, shuttle: { x: 1, y: 0, vx: 0, vy: 0 } },
    { recvTime: 66, shuttle: { x: 2, y: 0, vx: 0, vy: 0 } },
  ];
  const r = computeRender(buf, 133); // renderTime = 33, exactly on the second sample
  assert(r.mode === 'interpolate', 'exact-hit render time still interpolates cleanly');
  assert(approx(r.target.x, 1), 'render time landing exactly on a sample returns that sample\'s value');
}

console.log(failures === 0 ? '\nALL PASS (Phase 7: entity interpolation math)' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
