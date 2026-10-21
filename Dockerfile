# websps-mcp as a container: the MCP client starts it with `docker run -i --rm ...` and talks
# to it over stdio, exactly like a locally installed server.
#
# Release build (see CLAUDE.md, "Release"):
#   docker build --build-arg VERSION=0.1.1 --build-arg REVISION=$(git rev-parse HEAD) \
#     --build-arg SOURCE=https://github.com/wbrangl/websps-mcp -t websps-mcp:0.1.1 .

# node:22-alpine, pinned by digest for reproducible images; update deliberately per release.
ARG NODE_IMAGE=node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE}
ARG VERSION=dev
ARG REVISION=unknown
ARG SOURCE=""
LABEL org.opencontainers.image.title="websps-mcp" \
      org.opencontainers.image.description="MCP server for Web@SPS PLC devices" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.source="${SOURCE}" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    WEBSPS_STATE_DIR=/state
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY LICENSE README.md ./
# Logs, recordings, audit log and backups; mount a volume to keep them.
RUN mkdir /state && chown node:node /state
VOLUME /state
USER node
ENTRYPOINT ["node", "/app/dist/index.js"]
