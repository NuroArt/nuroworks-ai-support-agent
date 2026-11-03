# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Prisma's client is generated from the schema, so it must exist before next build.
RUN npx prisma generate && npm run build

FROM node:22-alpine AS runtime
RUN apk add --no-cache dumb-init
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

# `output: standalone` emits only the files actually imported, so the runtime
# image carries no dev dependencies and no build toolchain.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
# Needed at runtime for `prisma db push` and for rebuilding embeddings.
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=node:node /app/knowledge ./knowledge

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/admin/login',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

# dumb-init as PID 1 so SIGTERM reaches node and in-flight requests finish.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
