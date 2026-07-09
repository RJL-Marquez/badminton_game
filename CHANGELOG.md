# Changelog

All notable changes to this project are documented here. See [VERSIONING.md](VERSIONING.md) for the version format.

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
