# Node 24 runs the TypeScript entrypoints directly via strip-types; there is no
# build step, and therefore no build/runtime skew.
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY db ./db
COPY scripts ./scripts

# Never run as root.
USER node

EXPOSE 4010
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:4010/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-strip-types", "src/http/server.ts"]
