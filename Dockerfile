FROM node:22-alpine
WORKDIR /app

COPY package*.json ./
COPY tsconfig.base.json turbo.json ./
COPY packages/ packages/

# Copy only the docs package.json (satisfies workspace reference)
# but don't copy the actual docs app code (not needed for backend)
COPY apps/docs/package.json apps/docs/package.json

COPY server/ server/

RUN npm ci --ignore-scripts
RUN npx turbo run build --filter='!@codespar/docs'

EXPOSE 3000
CMD ["node", "server/start.mjs"]
