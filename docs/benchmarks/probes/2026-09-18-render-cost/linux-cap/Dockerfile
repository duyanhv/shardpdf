# Debian/glibc, matching Floor's production host (EC2 Ubuntu under PM2), not
# Alpine/musl: node-canvas and PDFKit behave differently enough on musl that a
# musl result would not speak to production.
FROM node:24-bookworm-slim

# node-canvas runtime deps. Floor's own Dockerfile relies on canvas prebuilds;
# these are what those prebuilds link against.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libjpeg62-turbo libgif7 librsvg2-2 \
      qpdf \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /probe
RUN npm init -y >/dev/null 2>&1 && npm i --no-audit --no-fund pdfkit@0.20.2 canvas@3.2.3 2>&1 | tail -2
COPY probe.mjs ./
CMD ["node", "--expose-gc", "probe.mjs"]
