# ── Build ────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── Runtime: the bundled server + static client, no node_modules ─────────────
FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/therebelrobot/plinth"
LABEL org.opencontainers.image.description="Isometric scene blocking for pixel art"
LABEL org.opencontainers.image.licenses="Unlicense"
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    STATIC_DIR=/app/dist/public \
    NODE_NO_WARNINGS=1
WORKDIR /app
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "dist/server.mjs"]
