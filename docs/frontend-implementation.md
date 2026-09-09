# PEPL frontend

The repository had domain services, SQL migrations and an unfinished Node HTTP/auth layer, but no frontend, registered endpoints or application server. The architecture documents describe a future Next.js/NestJS stack; this implementation adds a React/Vite client to the existing Node modular monolith instead of replacing the backend. PostgreSQL and its tenant-scoped transactions remain the source of truth.

Design: an ivory workspace on deep green, compact horizontal navigation, a generous welcome card, modular white/mint/coral surfaces, and shared accessible forms, tables, dialogs and status treatments. Summary cards use actual permitted records. Missing records do not become demo statistics.

Implementation order: secure HTTP integration; shared tokens/primitives and shell; dashboard; people and profiles; attendance/leave/approvals; payroll, tasks, announcements and settings; responsive and integration verification.

The browser uses an HttpOnly SameSite session cookie. The HTTP adapter forwards that token into the existing bearer-session authentication path. Every data endpoint uses `authed`, permissions, module configuration and scope checks. Mutations validate their inputs and use existing services where available. The frontend never supplies tenant context.

Development: `npm run dev` starts the API on 127.0.0.1:3100 and Vite on 127.0.0.1:5173. `npm run build` type-checks and builds the client. `npm start` serves the built client and API on 127.0.0.1:3100. `npm run verify` runs the existing database gates and tests; these tests reset the configured test database. Use only `pepl_test` for verification.

Hosting must support Node and the existing PostgreSQL connection. A static frontend-only deployment cannot preserve these workflows, and the local database is not reachable from Sites' hosted Workers.
