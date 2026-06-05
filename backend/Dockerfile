# Super Agent Backend — Production Dockerfile for ECS Fargate
# Multi-stage build: builder → production runtime

FROM public.ecr.aws/docker/library/node:22-slim AS builder
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
COPY prisma/ ./prisma/

# Generate Prisma Client and compile TypeScript
RUN npx prisma generate
RUN npx tsc -p tsconfig.build.json || true

# ---------------------------------------------------------------------------
# Production stage
# ---------------------------------------------------------------------------

FROM public.ecr.aws/docker/library/node:22-slim
WORKDIR /app

# Install curl for health checks
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

# Copy package files and install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev && npm install prisma@7 dotenv --no-save

# Copy compiled code and Prisma artifacts from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Copy Prisma schema, config, and migrations (needed for prisma migrate deploy)
COPY prisma/ ./prisma/
COPY prisma.config.ts ./

# Copy built-in skills and seed data
COPY skills/ ./skills/
COPY seeds/ ./seeds/

# Run as non-root node user (UID 1000)
USER node

EXPOSE 3000

CMD ["node", "dist/index.js"]
