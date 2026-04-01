FROM node:20

WORKDIR /app

COPY . .

# Install everything including devDependencies
RUN npm install --include=dev
RUN cd packages/dashboard && npm install --include=dev
RUN cd packages/server && npm install --include=dev

# Build
RUN cd packages/shared && npx tsc
RUN cd packages/dashboard && npx vite build
RUN cd packages/server && npx tsc

ENV NODE_ENV=production
EXPOSE 4100

CMD ["node", "packages/server/dist/index.js"]
