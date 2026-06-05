# ─── Build ────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .
# Exclude iOS/Capacitor native code from build context
RUN npm run build

# ─── Runtime ──────────────────────────────────────────────────────────────────
# Static PWA served by nginx — no Node.js runtime needed
FROM nginx:1.27-alpine AS runtime

COPY --from=build /app/build /usr/share/nginx/html

# SPA + PWA nginx config (port 3000, /health endpoint, cache headers)
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:3000/health" >/dev/null || exit 1

CMD ["nginx", "-g", "daemon off;"]
