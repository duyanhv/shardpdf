# Linux consumer smoke for @shardpdf/core. Builds the native binding from a
# clean git archive inside the container (no macOS artifacts), packs it, and
# runs smoke/consumer/run.sh including the Floor acceptance check.
#
#   docker build --platform linux/arm64 -f smoke/linux/Dockerfile -t shardpdf-linux-smoke .
#   docker run --rm shardpdf-linux-smoke
#
# Use --platform linux/amd64 for the x86_64 deployment target.
FROM node:24-bookworm AS toolchain
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq \
 && apt-get install -y -qq qpdf fonts-noto-cjk curl unzip build-essential pkg-config git \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | bash
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y -q --profile minimal
ENV PATH="/root/.bun/bin:/root/.cargo/bin:${PATH}"

FROM toolchain AS build
WORKDIR /src
COPY . .
# Never trust a host-built binding: remove and rebuild for this platform.
RUN rm -f crates/core/*.node \
 && bun install --frozen-lockfile \
 && cd crates/core && bun run build:release \
 && ls shardpdf-core.*.node \
 && node -e "const b=require('./native.js').buildInfo(); if (b.profile!=='release') process.exit(1); console.log(b)"

FROM build AS smoke
CMD ["bash", "-c", "echo \"node $(node --version) bun $(bun --version) $(qpdf --version | head -1) $(uname -m) $(ldd --version | head -1)\" && bash smoke/consumer/run.sh"]
