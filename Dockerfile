FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies for build
RUN npm ci

# Copy source code
COPY src/ ./src/
COPY shared/ ./shared/
COPY config/ ./config/
COPY tsconfig.json ./

# Build the application
RUN npm run build

# Remove dev dependencies for production
RUN npm ci --only=production && npm cache clean --force

# Create non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S tycostream -u 1001

# Change ownership
RUN chown -R tycostream:nodejs /app
USER tycostream

EXPOSE 4000

CMD ["npm", "start"]