FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production

# Pick up OS security patches released since this base image tag was
# last rebuilt (e.g. OpenSSL CVEs) — the cached base layer can lag
# behind Alpine's package repo.
RUN apk update && apk upgrade --no-cache

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src

# npm itself is a build-time tool (this image only ever runs `node
# src/server.js`, never `npm`) — its bundled internal dependencies
# (tar, sigstore, etc., vendored inside node:20-alpine's global npm
# install) show up as CVEs in image scans despite being unused at
# runtime. Removing it shrinks real attack surface, not just the scan.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Run as non-root
RUN addgroup -S app && adduser -S app -G app
USER app

EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:5000/health || exit 1

CMD ["node", "src/server.js"]
