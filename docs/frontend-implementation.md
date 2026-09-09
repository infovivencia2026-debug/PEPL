# PEPL frontend

The repository had domain services, SQL migrations and an unfinished Node HTTP/auth layer, but no frontend, registered endpoints or application server. The architecture documents describe a future Next.js/NestJS stack; this implementation adds a React/Vite client to the existing Node modular monolith instead of replacing the backend. PostgreSQL and its tenant-scoped transactions remain the source of truth.

Design: an ivory workspace on deep green, compact horizontal navigation, a generous welcome card, modular white/mint/coral surfaces, and shared accessible forms, tables, dialogs and status treatments. Summary cards use actual permitted records. Missing records do not become demo statistics.

Implementation order: secure HTTP integration; shared tokens/primitives and shell; dashboard; people and profiles; attendance/leave/approvals; payroll, tasks, announcements and settings; responsive and integration verification.

The browser uses an HttpOnly SameSite session cookie. The HTTP adapter forwards that token into the existing bearer-session authentication path. Every data endpoint uses `authed`, permissions, module configuration and scope checks. Mutations validate their inputs and use existing services where available. The frontend never supplies tenant context.

Development: `npm run dev` starts the API on 127.0.0.1:3100 and Vite on 127.0.0.1:5173. `npm run build` type-checks and builds the client. `npm start` serves the built client and API on 127.0.0.1:3100. `npm run verify` runs the existing database gates and tests; these tests reset the configured test database. Use only `pepl_test` for verification.

Hosting must support Node and the existing PostgreSQL connection. A static frontend-only deployment cannot preserve these workflows, and the local database is not reachable from Sites' hosted Workers.

## Delivered screens and components

The client routes are `#/dashboard`, `#/people`, `#/people/:id`, `#/attendance`, `#/leave`, `#/approvals`, `#/payroll`, `#/reports`, `#/tasks`, `#/announcements`, `#/activity`, and `#/settings`. Navigation is permission- and module-aware. Global search supports people and available pages, with Ctrl/Cmd+K. The notification panel supports marking updates as read. All summaries use database records; no reference-image metrics are hardcoded.

Shared primitives in `web/src/ui.tsx` include Button, Avatar, Badge, Card, PageHeader, Stat, Empty, SearchBox, ErrorBox, Skeleton, Modal, Tabs and Donut. `ActionForm` shares form validation, pending and error behavior. `web/src/styles.css` owns the visual tokens and responsive layout. The shell lives in `App.tsx`, with separate feature components.

Employee creation includes the initial employment assignment in one transaction, with plan limits enforced. Profile changes preserve effective-dated history. Attendance correction records a reason and respects closed/frozen periods. Leave submission prevents overlap and resolves the configured approver chain; final approval writes a single ledger debit and attendance corrections atomically. Payroll supports draft creation, reviewed inputs, freeze/unfreeze, calculation, validation, separate approval, locking and revisions. Input values and run configuration are frozen before calculation. Settings preserve effective dates and the frozen-period guard.

The existing `/api/v1` API arrived through concurrent backend work during implementation and remains intact. The UI adapter lives separately in `src/http/ui-routes.ts`, `ui-data.ts` and `ui-leave.ts`, under `/api/ui`. `app.ts` continues to construct the original API router for its tests. No UI routes should be added to that file.

## Boundaries and next iteration

- The frontend implements the existing core people/workforce/payroll workflows. Bulk employee import, documents/assets, birthdays, recruiting, performance, messaging and payment disbursement require additional backend support or dedicated screens; they are not represented by inert buttons or invented records.
- Leave creation currently supports full calendar days. The form explicitly explains that weekends count. Policy-aware holiday exclusion, half-days and cancellation/editing of returned requests should be completed before broad employee rollout.
- A payroll lock is not a payment. Payslip publication and disbursement remain separate backend concerns. The existing engine describes its TDS computation as simplified; this frontend does not replace those calculations or claim statutory certification.
- Settings use registry validation. Enum option metadata and a policy-version management screen would improve the editor further.
- The workspace endpoint returns complete permitted operational lists, with bounded activity and notification lists. Server-side pagination and module-specific data fetching are the next step for large tenants.
- Imported business-service API routes retain their prior behavior; this change does not claim to comprehensively audit every `/api/v1` endpoint. The browser-facing adapter adds explicit scope checks, action allowlists, module checks and transition locking.
- External font delivery currently uses Google Fonts, with local sans-serif fallbacks. Self-host fonts if offline use or deployment policy requires it.

`test/ui-workflows.test.ts` exercises the real database and HTTP adapter: authentication, self/report/tenant scope, compensation masking, invalid dates, unauthorized writes, atomic employee creation, leave overlap, one-time approval consumption, attendance projection, correction scope and the payroll lifecycle with separation of duties.

## Verification

Final verification passed: 14 suites / 270 tests, all 19 launch checks, the production build, and the frontend unused-code type check. Production dependency audit found zero vulnerabilities. Browser checks covered all delivered routes, employee creation and payroll draft/input review. Dashboard layouts were reviewed at widths 1920, 1440, 1366, 1280, 1024 and 390 pixels; screenshots are in docs/ui-checks. The final seeded preview contains eight employees and a draft September 2026 payroll run; no payroll was paid.


## Premium visual refinement

The dashboard now uses a wider emerald hero, a two-by-two metric composition, tonal ring details, layered shadows and staggered entrances. AmbientSculpture.tsx lazy-loads Three.js and renders three interlocking metallic rings. A CSS fallback remains when WebGL is unavailable. The scene respects reduced-motion preferences, provides a pause control, skips rendering offscreen/in background tabs, caps pixel density and disposes GPU resources on navigation. Three.js adds approximately 192 kB gzip as a separate on-demand chunk. Official renderer lifecycle reference: https://threejs.org/docs/pages/WebGLRenderer.html. Screenshots: docs/ui-checks/premium-desktop.png, premium-tablet.png and premium-mobile.png.


## Widget layouts and switching effects

Dashboard tiles are individually sortable through Customize dashboard, using dnd-kit pointer and keyboard sensors. Users can change widths, hide/restore widgets, save, cancel or reset. Layout preferences contain only widget identifiers and widths, stored per account in this browser; they do not sync across devices. Available tiles still come from the permission-filtered dashboard. Smaller screens adapt widths for readability. Drag handles support touch and Space/arrow-key controls, with explicit earlier/later buttons as an alternative. Tile contents are inert while customizing to avoid accidental HR actions.

Page switches use a short Three.js shader light sweep, an original Lottie three-tile accent, and CSS content transitions. Menus, dialogs and their backdrops animate on opening. Reduced-motion mode skips WebGL/Lottie switching effects and CSS transitions. Lottie uses the light player without expression evaluation; both animation libraries load separately. References: https://dndkit.com/legacy/presets/sortable/overview/ and https://github.com/airbnb/lottie-web/wiki/Usage.

Browser verification covered mouse dragging, keyboard reordering, save/reload persistence, hide/restore, resizing, reset/cancel, menu/dialog opening and reduced-motion rendering. Screenshots are in docs/ui-checks/widgets-*.png.


## Compact dashboard refinement

The decorative interlocking ring sculpture was removed because it competed with the PEPL identity. The welcome card now uses restrained contour line artwork, with no continuous hero animation. Three.js and Lottie page-switch effects remain. The dashboard heading is a compact 38-pixel row on desktop, with date and customization controls aligned alongside it; introductory filler copy is removed. Welcome/metric cards, radii, shadows and chart typography were tightened. Drag-and-drop widgets remain functional. Screenshots: docs/ui-checks/compact-desktop.png, compact-tablet.png and compact-mobile.png.

