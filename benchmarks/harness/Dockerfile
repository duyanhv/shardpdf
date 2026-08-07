# Simulated t3.small for benchmark runs. Build from the REPO ROOT:
#   docker build -t shardpdf-bench -f benchmarks/harness/Dockerfile .
# Run (this is where the 2 GiB / 2 vCPU cap actually comes from):
#   docker run --rm --memory=2g --memory-swap=2g --cpus=2 \
#     -v "$PWD/benchmarks/results:/repo/benchmarks/results" \
#     shardpdf-bench --runner pdf-lib --scale full --tag local-docker
FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends qpdf procps \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g bun

WORKDIR /repo
COPY package.json bun.lock turbo.json tsconfig.base.json biome.json ./
COPY benchmarks ./benchmarks
RUN bun install --frozen-lockfile

ENTRYPOINT ["node", "benchmarks/harness/run.ts"]
