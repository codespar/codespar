FROM node:22-alpine
WORKDIR /app

COPY package*.json ./
COPY tsconfig.base.json turbo.json ./
COPY packages/ packages/
COPY apps/ apps/
COPY server/ server/

RUN npm ci --ignore-scripts
RUN npx turbo run build --filter='!@codespar/docs'

EXPOSE 3000
CMD ["node", "server/start.mjs"]
