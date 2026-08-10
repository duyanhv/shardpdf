# Simulated resource-capped box for benchmark runs. Build from the REPO ROOT
# (requires a linux .node prebuild in crates/core/ — grab it from the CI
# prebuild artifacts, e.g. bindings-aarch64-unknown-linux-gnu):
#   docker build -t shardpdf-bench -f benchmarks/harness/Dockerfile .
#
# t3.small render matrix (2 GiB / 2 vCPU):
#   docker run --rm --memory=2g --memory-swap=2g --cpus=2 \
#     -v "$PWD/benchmarks/results:/repo/benchmarks/results" \
#     shardpdf-bench --runner pdf-lib --scale full --tag local-docker
#
# Floor-shaped bind/extract under their 768 MB export-child cap:
#   docker run --rm --memory=768m --memory-swap=768m --cpus=2 \
#     -v "$PWD/benchmarks/out:/repo/benchmarks/out" \
#     -v "$PWD/benchmarks/results:/repo/benchmarks/results" \
#     --entrypoint node shardpdf-bench benchmarks/bind/harness.ts \
#     --fixture benchmarks/out/production-floor/manifest.json --tag docker-768m
FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends qpdf procps \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g bun

WORKDIR /repo
COPY package.json bun.lock turbo.json tsconfig.base.json biome.json ./
COPY crates/core ./crates/core
COPY packages ./packages
COPY benchmarks ./benchmarks
RUN bun install --frozen-lockfile

ENTRYPOINT ["node", "benchmarks/harness/run.ts"]
