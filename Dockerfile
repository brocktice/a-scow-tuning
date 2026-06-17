# A Scow Tuner — Node app (Express + SQLite) serving the static front end + API.
FROM node:22-bookworm-slim AS build
WORKDIR /app
# build deps for better-sqlite3 native module
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8790 \
    DB_PATH=/data/atuner.db \
    STATIC_DIR=/app/public
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
# static front end (only the files the app needs — keeps secrets/sources out of the image)
COPY index.html app.js convert.js data.js styles.css ./public/
VOLUME ["/data"]
EXPOSE 8790
CMD ["node", "server/server.js"]
