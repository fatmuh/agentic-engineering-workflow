# syntax=docker/dockerfile:1
#
# Agentic Engineering Workflow dashboard: Next.js standalone server.
#
# Runtime env (required): DATABASE_URL, AUTH_SECRET.
# The schema creates and migrates itself on the first request (docs/deployment.md),
# so there is no migration step. Run one version at a time against a database.
#
# Session cookies are `Secure` in production: serve it behind HTTPS, or open it
# through http://localhost (an SSH tunnel counts). Plain http://<ip> cannot log in.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_OUTPUT_STANDALONE=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# src/lib/db.ts and src/lib/jwt.ts refuse to load without these, and the build
# loads them while collecting pages. Build-only placeholders: they never reach
# the runtime stage, and the build never connects to the database.
RUN DATABASE_URL=postgres://build:build@127.0.0.1:1/build \
    AUTH_SECRET=build-only-placeholder-0123456789abcdef0123456789abcdef \
    npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/login').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.js"]
