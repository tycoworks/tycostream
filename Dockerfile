FROM node:20-alpine

# Install build dependencies
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install all dependencies
RUN npm ci

# Copy source files
COPY tsconfig*.json ./
COPY src ./src
# Copy all yaml files to support different schema files
COPY *.yaml ./

# Build the application
RUN npm run build

# Remove dev dependencies and clean cache
RUN npm ci --only=production && \
    npm cache clean --force

# Expose GraphQL port
EXPOSE 4000

# Start the application
CMD ["npm", "start"]