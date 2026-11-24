# syntax=docker/dockerfile:1.7

# Stage 1: base
# Node 24 LTS on Alpine (Node 20 is end-of-life and no longer gets security fixes; NestJS 12
# is ESM-only and this CommonJS app loads it through Node's require(esm)). corepack ships
# with Node and provides pnpm for the build stages only — the runtime stage carries none of it.
# Pin pnpm explicitly — otherwise corepack pulls the LATEST pnpm.
# 10.33.4 matches the frontend and the lockfileVersion 9.0 lockfile.
FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate
WORKDIR /app

# Stage 2: deps
# Install ALL dependencies (incl. dev) for the build step. The lockfile is
# used verbatim so builds are reproducible across machines.
FROM base AS deps
# puppeteer's postinstall downloads a ~170 MB glibc Chrome from storage.googleapis.com.
# That build step cannot run on an air-gapped builder, and the binary it fetches will not
# execute on musl anyway. We install Alpine's own chromium in the runtime stage instead.
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Stage 3: builder
# Copy the full source tree on top of the resolved node_modules and run the
# Nest build. Output lands in dist/.
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The type-checking Nest build outgrew Node's default ~2 GB heap (OOM on the 1.2.23 release
# build under amd64 emulation). Build stage only — the runtime image is unaffected.
RUN NODE_OPTIONS=--max-old-space-size=4096 pnpm build

# Stage 4: prod-deps
# Production-only node_modules, resolved here so the runtime image never needs pnpm.
FROM base AS prod-deps
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Test runner images. Built only on the runner machine (docker compose --profile tm-runner-images build);
# the API image is unchanged because runtime stays the last stage.

# Jest, Vitest, Mocha and node --test; the Jest preset reads jest-junit from the global node_modules.
FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS tm-runner-node
RUN npm install -g jest-junit@17.0.0 mocha-junit-reporter@2.2.1 && npm cache clean --force
# The runner passes its own command.
ENTRYPOINT []

FROM mcr.microsoft.com/playwright@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e AS tm-runner-playwright

FROM cypress/included@sha256:c012c832d38d0892639a10d30aa649794f1e0bb38802388ac8f3d7d698c040b5 AS tm-runner-cypress
# Cypress is already in this image, and a run may only reach allowed sites, so a project's install must not download it.
ENV CYPRESS_INSTALL_BINARY=0
# Cypress records that it was checked in its own folder, which is read-only during a run, so that happens here.
RUN cypress verify
# The runner passes its own command; the base image would otherwise start Cypress before it.
ENTRYPOINT []

# JUnit through Maven; the settings file sends Maven through each run's proxy.
FROM maven@sha256:99e61abcff91a9b1333463bd8451fb18495d6eba9250ac66a338b518f8278320 AS tm-runner-junit
COPY docker/tm-runner-junit/settings.xml /usr/share/maven/conf/settings.xml
# The base image's start script needs /root, which a run can't write to because it isn't root.
ENTRYPOINT []

# The filtering proxy each run goes through; the worker mounts its settings into /etc/xis-proxy.
FROM alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc AS tm-runner-proxy
RUN apk add --no-cache tinyproxy
USER tinyproxy
CMD ["tinyproxy", "-d", "-c", "/etc/xis-proxy/tinyproxy.conf"]

# The worker that takes queued runs and starts their containers through the host's Docker.
FROM node:24-alpine AS tm-runner-worker
WORKDIR /app
ENV NODE_ENV=production \
    TM_RUNNER_WORKER=1 \
    TM_RUNNER_SCANNER=docker:aquasec/trivy@sha256:8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb
RUN apk add --no-cache docker-cli
COPY package.json pnpm-lock.yaml ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
CMD ["node", "dist/test-automation-runner/runner.worker"]

# Stage 5: runtime
# Slim final image: production deps only + compiled output. Runs as the
# built-in `node` user (uid 1000) for least-privilege.
#
# Built FROM the plain node image, not `base`: nothing at runtime runs npm, npx, corepack,
# pnpm or yarn (the app only spawns node, chromium and soffice), and those toolchains ship
# their own vulnerable dependency trees (tar, glob, minimatch, …). They are removed below so
# the shipped image carries only what it executes.
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Document Designer renders PDF/DOCX through puppeteer. `pdf-render.service.ts` expects the
# distro chromium and PUPPETEER_EXECUTABLE_PATH; without them every export fails with a
# browser-launch error and the endpoint 501s.
#
# Alpine's chromium is a musl build, which is the only kind that runs on this base image.
# The font packages are not optional: headless chromium with no fonts renders every glyph
# as a blank box, which looks like a broken template rather than a missing dependency.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
#
# `apk upgrade` first: the base image is only as fresh as its last publish, and Alpine ships
# OS security fixes (openssl, curl, zlib, …) between node image releases.
RUN apk upgrade --no-cache && \
    apk add --no-cache \
      chromium \
      libreoffice \
      nss \
      freetype \
      harfbuzz \
      ca-certificates \
      ttf-freefont && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*

COPY package.json pnpm-lock.yaml ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Healthcheck targets the existing public /api/v1/health endpoint via the
# wget binary that ships with node:*-alpine.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3001/api/v1/health || exit 1

USER 1000
EXPOSE 3001
# Must stay in step with `start:prod` in package.json. Node 22+ has a stable global
# WebSocket, so the --experimental-websocket flag supabase-js needed on Node 20 is gone.
CMD ["node", "dist/main"]
