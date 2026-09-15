# Acceptance Report — Audio ducking

## Item-by-item review
| AC | Result | Note |
|---|---|---|
| AC-3 Ducking while BGM plays | ❌ | verify-audio 21/23: gain envelope not restored after pause |
| AC-7 Ducking level persistence | ✅ | reload keeps the ducking level |

## Observations & leftovers
- BUG-1 (P1) is still open: the gain envelope is not restored after reload.

## Acceptance verdict: ❌ Fail
