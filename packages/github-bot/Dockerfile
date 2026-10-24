# syntax=docker/dockerfile:1
#
# The GitHub bot as a container: the Node entry (src/node/main.ts) bundled
# by `build:node`, listening on GITHUB_BOT_PORT with its delivery cache on
# GITHUB_BOT_STATE_DIR. The Worker build (`build`) is unchanged.
#
# Build from the repository root so the shared package is in the context:
#   docker build -f packages/github-bot/Dockerfile -t open-inspect-github-bot .

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/github-bot/package.json packages/github-bot/
# --ignore-scripts: the root package's prepare script installs git hooks
# through husky, which a workspace-scoped install does not bring along.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --workspace=@open-inspect/shared --workspace=@open-inspect/github-bot
COPY packages/shared/ packages/shared/
COPY packages/github-bot/ packages/github-bot/
RUN npm run build -w @open-inspect/shared \
    && npm run build:node -w @open-inspect/github-bot

FROM node:24-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    GITHUB_BOT_PORT=3200 \
    GITHUB_BOT_STATE_DIR=/state
WORKDIR /app
# node:24-slim carries no CA bundle, and Node does not need one: it verifies
# api.github.com against the roots compiled into it.
COPY --from=build /app/packages/github-bot/dist/node/main.js packages/github-bot/dist/node/main.js
RUN mkdir -p /state && chown node:node /state && chmod 700 /state
USER node
VOLUME ["/state"]
EXPOSE 3200
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.GITHUB_BOT_PORT}/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "/app/packages/github-bot/dist/node/main.js"]
