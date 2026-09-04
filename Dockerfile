FROM node:20-alpine AS builder

ARG NODE_AUTH_TOKEN

WORKDIR /app
COPY package.json package-lock.json ./
RUN printf '@facturero:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=%s\n' "$NODE_AUTH_TOKEN" > .npmrc && npm ci && rm -f .npmrc
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/sequelize.config.cjs ./
COPY --from=builder /app/migrations ./migrations
EXPOSE 3010
CMD ["node", "dist/main.js"]
