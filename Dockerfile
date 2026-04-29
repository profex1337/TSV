FROM node:20-alpine

RUN apk add --no-cache python3 make g++ \
    && rm -rf /var/cache/apk/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --build-from-source=better-sqlite3 \
    && apk del python3 make g++

COPY server.js ./
COPY index.html ./
COPY TSV.png ./

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/bookings.db

VOLUME ["/data"]
EXPOSE 3000

CMD ["node", "server.js"]
