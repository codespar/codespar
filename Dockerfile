FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY packages/ packages/
COPY tsconfig.base.json turbo.json ./
RUN npm ci
RUN npx turbo run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/package.json ./
EXPOSE 3000
CMD ["node", "packages/channels/cli/dist/index.js"]
