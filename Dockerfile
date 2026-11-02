# syntax=docker/dockerfile:1
#
# Containerized Habblaud: virtual office for Claude Code agents.
#
# Use `npm run docker:up` (scripts/docker-up.ts): it detects Claude Code accounts on the host,
# generates docker-compose.override.yml with READ-ONLY mounts of <account>/projects,
# <account>/sessions and ~/.habblaud/usage, and starts the service. This Dockerfile alone mounts nothing from the host.

# ---------------------------------------------------------------------------------------------
# Stage 1: build the client (Vite) and bundle the server (esbuild) into dist/.
# ---------------------------------------------------------------------------------------------
# The base image is pinned by digest (same across both stages) for reproducible builds; Dependabot
# (.github/dependabot.yml, docker ecosystem) updates tag and digest together when a new version is released.
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS builder
WORKDIR /app

# Dependencies first: the layer stays cached as long as the lockfile does not change.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# ---------------------------------------------------------------------------------------------
# Stage 2: lean runtime. The server has no runtime dependencies (only node:* modules),
# so dist/ and package.json (name, version, and "type": "module") are all that is needed.
# ---------------------------------------------------------------------------------------------
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS runtime

# HABBLAUD_USAGE_DIR: where docker-up mounts (read-only) the usage captured by the statusline tap.
ENV NODE_ENV=production \
    HABBLAUD_HOST=0.0.0.0 \
    HABBLAUD_PORT=4747 \
    HABBLAUD_IN_DOCKER=1 \
    HABBLAUD_DATA_DIR=/data \
    HABBLAUD_USAGE_DIR=/usage

WORKDIR /app

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/dist ./dist

# Habblaud state (persisted names). The named volume inherits this owner on the first mount.
RUN mkdir -p /data && chown node:node /data

# Unprivileged user (already exists in the official Node image). Code is owned by root,
# so the process cannot modify it; only /data is writable.
USER node

EXPOSE 4747
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4747/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "dist/server/index.js"]
