# Caldrenmoor game server: runs server/game/index.ts via tsx (sim uses extensionless TS imports)
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
# tsx is a devDependency, so install all deps, then run with it
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src/shared ./src/shared
COPY src/server ./src/server
COPY server ./server
COPY migrations ./migrations
EXPOSE 2567
USER node
CMD ["npx", "tsx", "server/game/index.ts"]
