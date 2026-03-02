# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

RUN npm install -g pnpm@9

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# ── Production stage ──────────────────────────────────────────────────────────
FROM node:20-slim AS runner

WORKDIR /app

RUN npm install -g pnpm@9

# Only production dependencies
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# Copy compiled output and runtime assets
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/skill ./skill
COPY --from=builder /app/drizzle ./drizzle

# Non-root user for security
RUN addgroup --system --gid 1001 truematch \
  && adduser --system --uid 1001 --ingroup truematch truematch \
  && chown -R truematch:truematch /app

USER truematch

EXPOSE 3000

CMD ["node", "dist/src/index.js"]
