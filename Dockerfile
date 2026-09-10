# Two stages, for one reason: the frontend needs a build and the server does not.
#
# Node 24 runs the TypeScript entrypoints directly via strip-types, so there is
# no server build step and therefore no build/runtime skew. The React app does
# have to be compiled, and its toolchain has no business in the image that faces
# the internet.

# --- stage 1: build the frontend -------------------------------------------
FROM node:24-slim AS web
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY web ./web
COPY vite.config.ts tsconfig.json ./
RUN npm run typecheck:web && npx vite build

# --- stage 2: the runtime ---------------------------------------------------
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY db ./db
COPY scripts ./scripts
# server.ts serves this directory; without it the container answers the API and
# returns "run npm run build" to every human who visits.
COPY --from=web /app/dist ./dist

# Never run as root.
USER node

EXPOSE 4010

# Readiness, not liveness: an instance whose database is unreachable is running
# but cannot serve, and a health check that cannot tell the difference sends
# traffic into a hole.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:4010/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-strip-types", "src/http/server.ts"]
