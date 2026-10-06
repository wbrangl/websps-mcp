# websps-mcp as a container: the MCP client starts it with `docker run -i --rm ...` and talks
# to it over stdio, exactly like a locally installed server.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
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
