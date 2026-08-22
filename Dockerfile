FROM node:22-alpine
WORKDIR /app

COPY package.json ./
COPY tsconfig.base.json turbo.json ./
COPY packages/ packages/
COPY server/ server/

RUN npm install --ignore-scripts --legacy-peer-deps
RUN npx turbo run build

# State directory. The runtime keeps its API credential here (see
# packages/core/src/server/api-token.ts) and FileStorage keeps org data here
# when DATABASE_URL is unset. Created in the image and owned by `node` so a
# fresh named volume mounted at this path inherits that ownership instead of
# arriving owned by root.
RUN mkdir -p /app/.codespar && chown -R node:node /app

# Drop root. POST /sessions accepts a command and the MCP bridge spawns it,
# so the blast radius of anything that reaches that path is whatever this
# user can do. Authentication is what stops an anonymous caller getting there
# (BLOCKER oss-sdk#5); this is the second line, for a caller who is
# authenticated but should still not own the container. It has earned its
# keep already: the guard in front of that path was bypassed twice during
# this fix alone.
#
# Nothing here needs root: the port is 3000 and the build already ran.
#
# One upgrade case needs the operator's attention, and the entrypoint checks
# for it explicitly rather than letting it surface as a stack trace. A volume
# left behind by an earlier release that ran as root stays root-owned across
# the upgrade, and `node` then cannot write to it. The generated credential
# falls back to another directory on its own, but FileStorage does not: it is
# the datastore, so there is nowhere to fall back to. See preflightStateDir
# in server/start.mjs, which reports the one-line chown that fixes it.
USER node

EXPOSE 3000
CMD ["node", "server/start.mjs"]
