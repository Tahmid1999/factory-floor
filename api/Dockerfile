# One image, two commands: `node dist/main` is the API, `node dist/worker` the
# worker. Debian slim rather than Alpine because Prisma's engines want glibc
# and openssl, and a musl mismatch only shows up at the first query.

FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# postinstall runs `prisma generate`, so the schema has to be here before npm ci.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
# Production install only. prisma and dotenv are regular dependencies so that
# postinstall (prisma generate) and `npm run migrate:prod` work in this image;
# moving two packages was smaller than carrying a second stage with dev deps.
RUN npm ci --omit=dev && npm cache clean --force
COPY scripts ./scripts
COPY --from=build /app/dist ./dist
USER node
EXPOSE 4120
CMD ["node", "dist/main"]
