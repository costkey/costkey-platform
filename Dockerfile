FROM node:20

WORKDIR /app

COPY . .

# Fresh install for this platform (lockfile has macOS ARM binaries)
RUN rm -rf node_modules packages/*/node_modules package-lock.json packages/*/package-lock.json
RUN npm install

# Build (cache bust: v3)
RUN cd packages/shared && npx tsc
RUN cd packages/dashboard && npx vite build
RUN cd packages/server && npx tsc

ENV NODE_ENV=production
EXPOSE 4100

CMD ["node", "packages/server/dist/index.js"]
