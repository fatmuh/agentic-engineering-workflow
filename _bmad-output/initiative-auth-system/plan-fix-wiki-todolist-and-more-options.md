---
title: 'Fix Wiki to-do list checkbox interactivity and three dots active state indicator'
type: 'bugfix'
ticket: ''
created: '2026-11-05'
status: 'in-progress'
baseline_revision: 'bd8134041543714bcb3112154edb33fde74e89d0'
route: 'oneshot'
route_source: 'auto'
risk: 'low'
review: 'quick'
review_source: 'pinned'
lenses_ran: []
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Task list items in the Wiki editor trigger React "Maximum update depth exceeded" cascading re-render loops upon checkbox toggles due to unbounded `onTransaction` and `WikiBlockControls` update listeners, blocking checkbox interaction; additionally, formatting controls inside the "Three dots" (`More formatting options`) dropdown lack visual contrast between active and inactive states.

**Approach:** Stabilize `WikiBlockControls` position caching and eliminate the cyclic re-render trigger on ProseMirror transactions; replace the misleading checkmark icon with a task list icon and add `Mod-Enter` task toggle support; apply distinct contrast tokens and active attributes to the "Three dots" summary button and dropdown options (inline code and callout).

</frozen-after-approval>

## Implementation Notes

Small bugfix under 100 lines touching wiki editor components and CSS.

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `npx tsc --noEmit` -- expected: 0 errors
- `npm test` -- expected: all unit tests pass
- `node scripts/check-wiki-reference.mjs` -- expected: UI reference checks pass
- `npx playwright test e2e/wiki.spec.ts --workers=1` -- expected: e2e tests pass
