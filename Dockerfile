FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/dashboard/package.json packages/dashboard/

# Install all deps
RUN npm install

# Copy source
COPY packages/shared/ packages/shared/
COPY packages/server/ packages/server/
COPY packages/dashboard/ packages/dashboard/
COPY tsconfig.base.json ./

# Build shared types
RUN cd packages/shared && npx tsc

# Build dashboard
RUN cd packages/dashboard && npm install && npm run build

# Build server
RUN cd packages/server && npm install && npx tsc

ENV NODE_ENV=production
EXPOSE 4100

CMD ["node", "packages/server/dist/index.js"]
