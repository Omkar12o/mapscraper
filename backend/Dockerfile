FROM node:20-alpine
WORKDIR /app
ENV PORT=5000 \
    SCRAPER_URL=http://scraper:8080 \
    SCRAPER_MAX_TIME_SECONDS=300 \
    SCRAPER_DEPTH=10 \
    SCRAPER_RADIUS=10000 \
    MAX_RETRIES=1 \
    POLL_INTERVAL_MS=5000 \
    DB_PATH=/data/leadfinder.db
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js providers.cjs cities.json areas.json cityCoords.json ./
RUN mkdir -p /data
EXPOSE 5000
CMD ["node", "server.js"]
