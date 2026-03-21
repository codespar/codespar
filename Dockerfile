FROM node:22-alpine
WORKDIR /app

COPY package.json ./
COPY tsconfig.base.json turbo.json ./
COPY packages/ packages/

# Minimal docs reference (satisfies workspace, not used in build)
RUN mkdir -p apps/docs && echo '{"name":"@codespar/docs","version":"0.1.0","private":true}' > apps/docs/package.json

COPY server/ server/

RUN npm install --ignore-scripts --legacy-peer-deps
RUN npx turbo run build --filter='!@codespar/docs'

EXPOSE 3000
CMD ["node", "server/start.mjs"]
