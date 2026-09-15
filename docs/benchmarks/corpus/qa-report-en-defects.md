# QA Test Report — Tetris v2.8

## Scope & environment
- Scope: local persistence (high score + four settings)
- Environment: node test/verify*.cjs (jsdom, no browser dependency)

## Test cases & results
| Case | Result | Note |
|---|---|---|
| verify-game | PASS | 52/52 |
| verify-audio | PASS | 23/23 |
| verify-persist | PASS | 10/10 |

## Manual re-test list
- Real file:// browser reload keeps persistence (AC-16 / AC-10.5)

## Defects
| ID | Severity (P0/P1/P2/P3) | Module | Steps | Expected | Actual | Related AC |
|---|---|---|---|---|---|---|
| BUG-1 | **P1** | persist.js | Real browser reload | Score/settings kept | All lost (TypeError swallowed) | AC-16, AC-10.5 |
| BUG-2 | P2 | audio.js | Mute then reload | Mute kept | Reset to default | AC-10.5 |
| OBS-3 | P3 | game.js | Rapid repeated kicks | No jitter | Occasional jitter | — |

## Conclusion
P0/P1/P2 defects found; send back to development for fix and re-verification.
