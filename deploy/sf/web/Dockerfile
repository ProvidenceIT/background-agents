# syntax=docker/dockerfile:1
#
# Software-factory web image (sf/main only, never upstreamed). Built by
# .github/workflows/sf-release.yml from the repository root with
#   -f deploy/sf/web/Dockerfile
# BuildKit picks up the sibling deploy/sf/web/Dockerfile.dockerignore in place of
# the repository's .dockerignore (which admits only the control-plane and teams-bot inputs).
# Moved from the private overlay notes/manifests/oi-overlay-sf/web/; originally
# repos/background-agents/deploy/kubernetes/web/Dockerfile (branch feat/k8s-sandbox-provider,
# commit 97ae675c). Keep deploy/sf/components.json ("web") in step with the COPY lines below.
#
# The web app as a Next.js standalone server, for running next to the
# control-plane container. NEXT_PUBLIC_* values are inlined into the client
# bundle at build time, so the image is built per deployment:
#
#   docker build -f deploy/sf/web/Dockerfile \
#     --build-arg NEXT_PUBLIC_WS_URL=wss://open-inspect.example.com \
#     --build-arg NEXT_PUBLIC_SANDBOX_PROVIDER=kubernetes \
#     -t open-inspect-web .
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/web/package.json packages/web/
# --include-workspace-root: `next build` type-checks the whole package, tests
# included, and those import root dev dependencies (eslint) and the shared
# coverage policy under scripts/.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --include-workspace-root \
      --workspace=@open-inspect/shared --workspace=@open-inspect/web
COPY scripts/coverage-policy.ts scripts/coverage-baseline.json scripts/
COPY packages/shared/ packages/shared/
COPY packages/web/ packages/web/
ARG NEXT_PUBLIC_WS_URL
ARG NEXT_PUBLIC_SANDBOX_PROVIDER=kubernetes
ARG NEXT_PUBLIC_SCM_PROVIDER=github
ARG NEXT_PUBLIC_APP_NAME
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_WS_URL=${NEXT_PUBLIC_WS_URL} \
    NEXT_PUBLIC_SANDBOX_PROVIDER=${NEXT_PUBLIC_SANDBOX_PROVIDER} \
    NEXT_PUBLIC_SCM_PROVIDER=${NEXT_PUBLIC_SCM_PROVIDER} \
    NEXT_PUBLIC_APP_NAME=${NEXT_PUBLIC_APP_NAME}
RUN npm run build -w @open-inspect/shared && npm run build -w @open-inspect/web

FROM node:24-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
# outputFileTracingRoot is the monorepo root, so the standalone tree mirrors it.
COPY --from=build --chown=node:node /app/packages/web/.next/standalone ./
COPY --from=build --chown=node:node /app/packages/web/.next/static ./packages/web/.next/static
COPY --from=build --chown=node:node /app/packages/web/public ./packages/web/public
USER node
EXPOSE 3000
CMD ["node", "packages/web/server.js"]
