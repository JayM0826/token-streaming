FROM node:22-alpine AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/tsconfig.json packages/protocol/
COPY packages/protocol/src packages/protocol/src
COPY apps/supplier-node/package.json apps/supplier-node/tsconfig.json apps/supplier-node/
COPY apps/supplier-node/src apps/supplier-node/src
RUN corepack pnpm@9.15.0 install --frozen-lockfile
RUN corepack pnpm@9.15.0 --filter @token-streaming/supplier-node... build
RUN corepack pnpm@9.15.0 --filter @token-streaming/supplier-node deploy --prod /release

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S -g 10001 supplier && adduser -S -D -H -u 10001 -G supplier supplier
COPY --from=build --chown=supplier:supplier /release ./
USER supplier
EXPOSE 8789
ENTRYPOINT ["node", "dist/index.js"]
CMD ["serve"]
