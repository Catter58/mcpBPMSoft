# syntax=docker/dockerfile:1

# ---- Stage 1: build ----
# Compile TypeScript (src/) into build/ with full devDependencies.
FROM node:22-alpine AS build

WORKDIR /app

# Install all dependencies (incl. dev) using the lockfile for reproducible builds.
COPY package.json package-lock.json* ./
RUN npm ci

# Copy sources and compile.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies — keep only what runtime needs.
RUN npm prune --omit=dev

# ---- Stage 2: runtime ----
# Minimal image: production node_modules + compiled build/ only.
FROM node:22-alpine AS runtime

ENV NODE_ENV=production

# MCP Streamable HTTP transport. Bind 0.0.0.0 so the port is reachable
# from outside the container; put a TLS proxy + firewall in front for prod.
# BPMSOFT_URL is the only required env var — pass it at `docker run`.
ENV MCP_TRANSPORT=http \
    MCP_HTTP_HOST=0.0.0.0 \
    MCP_HTTP_PORT=8007

WORKDIR /app

# Run as the non-root `node` user shipped in the base image.
COPY --chown=node:node package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/build ./build

USER node

EXPOSE 8007

CMD ["node", "build/index.js"]
