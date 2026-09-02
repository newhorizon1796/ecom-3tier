# --- build stage ---
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# --- runtime stage ---
FROM nginx:1.27-alpine
# Pick up OS security patches released since this base image tag was
# last rebuilt (e.g. OpenSSL CVEs) — the cached base layer can lag
# behind Alpine's package repo.
RUN apk update && apk upgrade --no-cache && apk add --no-cache curl
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/build /usr/share/nginx/html
RUN adduser -D -H -u 101 -s /sbin/nologin appuser || true
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://localhost/ || exit 1
CMD ["nginx", "-g", "daemon off;"]
