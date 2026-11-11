# Build: compile the TypeScript, with every dependency
FROM node:24-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

# Run: the compiled code and production dependencies only
FROM node:24-alpine

LABEL org.opencontainers.image.source="https://github.com/tycoworks/tycostream" \
      org.opencontainers.image.description="Turn Materialize views into real-time GraphQL APIs" \
      org.opencontainers.image.licenses="MIT OR Apache-2.0"

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && \
    npm cache clean --force

COPY --from=build /app/dist ./dist

USER node

EXPOSE 4000

# Node itself, not npm, so a stop signal reaches Nest's shutdown hooks
CMD ["node", "dist/main"]
