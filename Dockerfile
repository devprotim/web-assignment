# Single image serving the API and the built Angular bundle from one origin.
#
# tfjs-node ships a prebuilt native binding, so this needs a glibc base
# (bookworm, not alpine) and the build toolchain present while installing.

FROM node:22-bookworm-slim AS build
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Manifests first, so a dependency install is only redone when they change.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY . .
# Not "npx prisma": @prisma/client's optional peer dependency on a floating
# "prisma": "*" range hoists whatever is the current latest dist-tag to the
# repo root (an 8.0.0-rc.x with a different, incompatible CLI at the time of
# writing), shadowing the version actually pinned for apps/api. Running the
# pinned binary directly from that workspace avoids the ambiguity entirely.
RUN npm run build -w @chat/shared \
 && (cd apps/api && node node_modules/prisma/build/index.js generate) \
 && npm run build -w @chat/api \
 && npm run build -w @chat/web

# Drop dev dependencies from the layer that ships.
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
COPY --from=build /app/apps/api/prisma.config.ts ./apps/api/prisma.config.ts
# npm nests its own pinned copy of prisma here (see the build-stage comment
# above); the root node_modules copy above is not the one to run.
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/web/dist ./apps/web/dist

# Do not run as root.
USER node
EXPOSE 3000

# Migrations run at boot so a deploy needs no separate release step.
CMD ["sh", "-c", "cd apps/api && node node_modules/prisma/build/index.js migrate deploy && cd /app && node apps/api/dist/main.js"]
