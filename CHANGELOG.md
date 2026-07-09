# Changelog

All entries below are scoped to `index.html` only — no other files were touched.

## Unreleased — Gravity & Hard AI positioning tuning

### 1. Global fall-speed increase (regular hits harder to run down)
- `SHUTTLE_GRAVITY`: `700 → 950`
- `SHUTTLE_TERMINAL_VY`: `190 → 260`
- Applied to float hits, serves, net-cord bounces, and (at the time) every shot's
  pre-dive flight segment — making the descent noticeably steeper and harder to
  chase down across the board.

### 2. Dinks exempted from the fall-speed increase
The gravity bump above ended up affecting dinks too, which wasn't the intent —
a dink is a deliberately soft, carefully-tuned touch shot, not something that
should get harder to run down.

- Added dedicated constants restoring the **original pre-bump values**, scoped
  only to a dink's pre-net flight:
  - `DINK_PRE_NET_GRAVITY = 700`
  - `DINK_PRE_NET_TERMINAL_VY = 190`
- `simulateDinkFlight()`, `solveDinkTrajectory()` (arc-height solve), and the
  live per-frame flight update in `updateShuttle()` now all use these instead
  of the bumped `SHUTTLE_GRAVITY` / `SHUTTLE_TERMINAL_VY`.
- **Net effect:** floats and serves keep the faster, harder-to-chase fall.
  Dinks play exactly as they did before the gravity bump. The dink's post-net
  dive constants (`DINK_POST_NET_GRAVITY_BASE`, `DINK_POST_NET_TERMINAL_VY`)
  were already separate and are untouched either way.
- Refactored the gravity/terminal-vy selection out of `updateShuttle()` into
  two small helpers, `currentShuttleGravity()` / `currentShuttleTerminalVy()`,
  so this rule lives in exactly one place (also reused by the AI landing
  predictor below, instead of being duplicated).

### 3. Hard AI no longer camps at the net after hitting
Previously the AI's movement target was just "the shuttle's current position
plus a tiny 0.15s lead." After the AI played a dink, the shuttle stayed slow
and close to the net for a moment, so the AI kept re-targeting that same spot
and effectively stood there instead of resetting for the next shot.

- Added `predictShuttleLandingX()` — a lightweight forward simulation of the
  shuttle's actual current trajectory/gravity that estimates where it will
  eventually land. Approximate by design (holds today's gravity for the whole
  simulated flight rather than re-deriving every future dive trigger) — cheap
  enough to call every AI decision tick, and accurate enough for movement
  planning.
- Added `AI_READY_STANCE_X`, reusing the same well-back-from-the-net position
  already used for the AI's serve stance.
- `updateAI()`'s decision logic now branches on the shuttle's direction:
  - **Shuttle heading toward the AI** (`shuttle.vx > 0`): target the predicted
    landing spot, so the AI starts moving early like a player reading the
    shot, instead of only reacting once the shuttle arrives.
  - **Shuttle heading away** (just hit it, or the opponent hasn't returned it
    yet): recover toward `AI_READY_STANCE_X` instead of drifting to and
    sitting at wherever the shuttle currently is.
- Existing swing-timing logic (`inReach`, `canReachHeight`, jump decisions,
  the hard-difficulty dash trigger, etc.) is untouched — only the background
  positioning target changed.

