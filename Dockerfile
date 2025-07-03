FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm ci --only=production

# Copy source code
COPY src/ ./src/
COPY shared/ ./shared/
COPY schema/ ./schema/
COPY tsconfig.json vitest.config.ts ./

# Build the application
RUN npm run build

# Create non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S tycostream -u 1001

# Change ownership
RUN chown -R tycostream:nodejs /app
USER tycostream

EXPOSE 4000

CMD ["npm", "start"]