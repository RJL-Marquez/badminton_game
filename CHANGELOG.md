# Changelog

All notable changes to this project are documented here. See [VERSIONING.md](VERSIONING.md) for the version format.

## [1.3.0] - 2026-07-09 — Integration merge (jared-branch + rence-branch)

Merges the Advanced Controls / rally-result work developed on `jared-branch` with the
gravity tuning and AI positioning/behavior improvements developed independently on
`rence-branch`. Both feature sets are additive and touch separate regions of
`index.html` (menu/input/scoring vs. shuttle physics/AI targeting), so no functionality
from either branch was dropped or overwritten — see the dedicated entries below for
what each branch contributed.

## [1.2.0] - 2026-07-09

### Added
- **Rally result indicators** — the existing rally-end overlay now shows *why* the point ended, above the "Left/Right scores" line: OUT, NET FAULT, SERVICE FAULT, SHUTTLE LANDED, or DOUBLE HIT, matched exactly to the collision/fault branch that ended the rally. The overlay fades out over its last 0.3s instead of disappearing abruptly.

### Changed
- **Reduced maximum attack angle** — the positive side of the manual attack angle is now capped at +15° (was +30°); the negative side is extended to -45° (was -30°). New positions: -45° / -30° / -15° / 0° / +15°, still evenly spaced (15° steps) and still defaulting to 0°. This keeps smashes/clears from being pushed unrealistically upward while still allowing a much steeper downward attack angle than before.

## [1.1.0] - 2026-07-09

### Changed
- **Simplified attack angle range** — manual attack angle is now a fixed 3-position control: -30° / 0° / +30° (previously -40° to +40° in 10° steps). Each press of the increase/decrease key jumps directly to the next of the three positions.

### Added
- **Configurable key bindings** — the four attack-angle actions (P1 Angle Up/Down, P2 Angle Up/Down) can now be rebound from Settings > Advanced Controls > Attack Angle Keys. Click a binding, press any key to assign it. Rejects keys already used by core gameplay (movement, jump, hit, pause, restart) or by another angle action, with a brief "TAKEN" flash. A "Reset to Defaults" button restores Q/E/U/O. Bindings are session-only (not persisted), consistent with the rest of the Settings panel.

## [1.0.0] - 2026-07-09

### Added
- **Advanced Controls Mode** — new "Advanced Controls" section in Settings with an Enable/Disable toggle. Off by default; when off, gameplay is byte-for-byte unchanged from before.
- **Manual attack angle control** — each human player gets an independent attack angle, -40° to +40° in 10° steps, default 0°.
  - Player 1: `Q` increase, `E` decrease.
  - Player 2: `U` increase, `O` decrease (only while human-controlled, i.e. Local Multiplayer).
  - Applies to smash and clear ("float") shots — positive angle flattens/lifts the shot, negative steepens it. Net dinks are unaffected (they use a distance-target solver, not a direct angle).
- **Attack direction indicator** — a small rotating chevron near each human player showing their current attack angle in real time. Hidden for AI-controlled players and whenever Advanced Controls is off.
- **HUD angle readout** — "ANGLE +20°" style text under each human player's name on the scoreboard, shown only when Advanced Controls is on.
- **Main Menu version display** — "Version 1.0.0" shown in the bottom-left corner of the Main Menu, read from a single centralized `GAME_VERSION` constant.
- `VERSIONING.md` — versioning policy and reminder for future AI-assisted changes.
- `CHANGELOG.md` — this file.

### Notes
- AI-controlled players completely ignore Advanced Controls: their attack angle is always 0 and cannot be changed via input, regardless of prior session state.
- Attack angles reset to 0° at the start of every match (`Start Game` / `Restart Match`), same lifecycle as score and position.

---

## Gravity & Hard AI Positioning Tuning — 2026-07-09

*(from `rence-branch`, scoped entirely to `index.html`)*

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

## AI Behavior Fix — 2026-07-09

*(from `rence-branch`, commit "fix AI Behavior", scoped entirely to `index.html`; not
previously documented in this file)*

- **Variable AI charge duration** — each `AI_PROFILES` difficulty now specifies
  `chargeDurationMin`/`chargeDurationMax` instead of a single fixed `chargeDuration`.
  The AI re-rolls a random value in that range on every regular swing, so its charge
  gauge visibly varies shot-to-shot instead of always charging to roughly the same
  point, while each difficulty's average charge stays about where it was.
- **Smarter "is this shot a threat" check** — `updateAI()` no longer starts chasing
  the shuttle's predicted landing spot the instant it's heading toward the AI's side.
  A new per-difficulty `anticipateMargin` (px from the net) gates it: the shuttle must
  be heading toward the AI **and** within `anticipateMargin` of the net before the AI
  treats it as a real threat and starts moving early. Easy barely reacts before the
  shuttle is already close; Hard reads the shot and starts moving much sooner. Outside
  that window, the AI holds its ready stance instead of drifting toward wherever the
  shuttle currently is.
