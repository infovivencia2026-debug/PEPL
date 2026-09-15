# Viewport layout review

The application shell fits the browser viewport. Navigation remains visible; longer screens scroll within the content region, with sticky page headings. Tables and dialogs retain their own scrolling where needed. Changing routes resets the content to the top.

The desktop dashboard displays 12 compact widgets in four rows without pagination. Redundant new-joiner and payroll headline tiles were removed; their detailed cards remain. Narrow screens retain adaptive pagination for readability. Customize mode shows the full editable board with internal scrolling and retains drag, resize, hide, save, cancel, and reset behavior.

## Files reviewed

- `CODEX-BRIEF.md`: consolidated architecture and feature handoff. Its permission, tenancy, error handling, and feature boundaries remain authoritative context for implementation.
- `API-HANDOFF.md`: pointer to the consolidated brief.
- `openapi.json`: generated API contract; left unchanged.

Reviewing these documents did not expand this layout task into implementing the backend feature backlog.

## Verification

- 72 route/viewport checks across six viewport sizes, including employee profiles: zero failures.
- All 12 dashboard widgets reachable at each tested size, together on desktop.
- Responsive audit across eight device sizes: passed.
- Production build: passed.
- Previous viewport revision: 480 tests and 19 launch checks passed. The compact revision's full-suite attempt was stopped when another test process was found using the shared database; a fresh full-suite result is pending.
- Three pagination tests cover order preservation, narrow layouts, and empty/invalid inputs.

Browser results are recorded in `docs/ui-checks/viewport-report.json`, with screenshots alongside it. Run the viewport sweep with `node --experimental-strip-types scripts/viewport-check.ts` while the local app is running.
