<!-- STATUS: DRAFT -->
# ADR-0004: Add a per-level countdown timer, overriding PRD NFR-004

Owner: Chief of Staff | Date: 2026-10-11 | Reviewer: product-owner, ux-architect | **Decision maker: Founder**

Inputs: Founder decision in chat (2026-10-11), given when asked explicitly: Founder chose "Add a real countdown timer" over "keep the no-timer rule" after being shown the conflict. delivery/G2-product-definition/prd.md NFR-004 ("No time limit on probes; keyboard-operable UI; text alternative"). Plan: `imperative-tumbling-hearth` (sandbox hardening, Phase 1 item 3).

## Status
**Accepted by Founder.** Supersedes NFR-004 for exam levels L1-L4 specifically (probes outside the timed levels, if any are added later, are unaffected unless a separate decision extends this).

## Context and forces
| Force | Source | Implication |
|---|---|---|
| NFR-004 exists to avoid penalizing slower readers/typers; it is an explicit accessibility guarantee, not an incidental default | PRD NFR-004, accessibility rules (`.claude/rules/frontend-a11y.md`) | Removing it is a real accessibility regression, not a cosmetic change |
| Founder wants exam pacing visible and bounded for the demo/benchmark framing ("Standardized Workforce Benchmark") | Founder request 2026-10-11 | A visible countdown + auto-submit on expiry is the concrete ask |
| Existing architecture already has a `finish()` call path (manual and already used on fullscreen-exit-driven flows) | `product/entrypoints/web/src/pages/Exam.tsx` | Auto-submit on expiry can reuse it without a new backend endpoint |

## Decision
Add a client-side countdown per level (L1: 8 min, L2: 15 min, L3: 25 min, L4: 20 min), shown
in the exam top bar (`ExamTopBar`, `role="timer"`, `aria-live="polite"` so screen readers get
periodic updates rather than silence). The deadline is anchored once per attempt (stored in
`sessionStorage` keyed by `attempt_id`) so a reload does not grant extra time, and does not
reset the clock if the learner is merely re-rendering. On expiry, the existing `finish()` path
is called automatically, exactly as if the learner clicked "Finish this level."

No deterministic-check runner limits changed; this is purely a client-visible pacing
constraint layered over the existing untimed backend.

## Consequences
- **Accessibility regression, accepted knowingly**: learners who read or type more slowly are
  now structurally disadvantaged on L1-L3 relative to the no-timer design the PRD specified.
  If this ships past the hackathon demo, NFR-004 needs either reinstatement or an explicit,
  reviewed time-extension accommodation path (not scoped here).
- M5 (completion/retry rate) and M4 (feedback usefulness) in `success-metrics.md` should be
  re-read in light of this: a lower completion rate after this change may reflect the timer,
  not task difficulty - note this explicitly when reporting those metrics.
- The timer is enforced client-side only (no backend deadline). A learner who disables
  JavaScript or tampers with `sessionStorage` is not blocked server-side. Given the existing
  threat model already treats the API, not the browser, as the trust boundary for scoring
  integrity, this is an accepted gap for this scope (pacing UX, not an anti-cheat control).
- Levels remain resumable (`status` stays `in_progress` if the learner leaves and returns
  before the deadline); only expiry itself triggers forced submission.

## Open questions
- Should L4 (live interview) use the same mechanism, or does its turn-based pacing need a
  different timeout model (per-turn vs. whole-session)? Deferred to the Phase 1 verification
  pass.
- Should slower-than-average learners be able to request more time (a documented, auditable
  accommodation), restoring part of NFR-004's intent without removing the timer entirely?
  Not decided; flagged for a future Founder decision if this goes past the demo.
