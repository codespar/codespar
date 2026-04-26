FROM node:22-alpine
WORKDIR /app

COPY package.json ./
COPY tsconfig.base.json turbo.json ./
COPY packages/ packages/
COPY server/ server/

RUN npm install --ignore-scripts --legacy-peer-deps
RUN npx turbo run build

EXPOSE 3000
CMD ["node", "server/start.mjs"]
