FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY backend/package*.json ./
RUN npm ci --only=production

# Copy source code
COPY backend/ ./
COPY shared/ ../shared/
COPY graphql/ ../graphql/

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