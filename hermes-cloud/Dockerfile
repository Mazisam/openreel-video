# Build context MUST be the OpenReel fork root, not hermes-cloud/.
FROM node:24-bookworm-slim AS build
WORKDIR /repo/hermes-cloud
COPY hermes-cloud/package.json hermes-cloud/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY packages/agent /repo/packages/agent
COPY packages/core /repo/packages/core
COPY packages/creation-schema /repo/packages/creation-schema
COPY hermes-cloud/src ./src
COPY hermes-cloud/build.mjs ./
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 fonts-dejavu-core fonts-noto-core util-linux ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /repo/hermes-cloud/dist ./dist
COPY --from=build --chown=node:node /repo/hermes-cloud/node_modules ./node_modules
COPY --from=build /repo/hermes-cloud/package.json ./package.json
COPY LICENSE /app/OPENREEL-LICENSE
COPY hermes-cloud/LICENSE /app/CONNECTOR-LICENSE
COPY hermes-cloud/entrypoint.sh /usr/local/bin/openreel-entrypoint
RUN chmod 0755 /usr/local/bin/openreel-entrypoint && mkdir /data && chown node:node /data
ENV DATA_DIR=/data PORT=8080 RENDER_LOCATION=cloud NODE_ENV=production
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/openreel-entrypoint"]
CMD ["node","dist/server.mjs"]
