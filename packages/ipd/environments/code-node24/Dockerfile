# syntax=docker/dockerfile:1
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       bash=5.2.15-2+b13 build-essential=12.9 ca-certificates=20250419~deb12u1 \
       git=1:2.39.5-0+deb12u3 python3=3.11.2-1+b1 ripgrep=13.0.0-4+b2 \
    && rm -rf /var/lib/apt/lists/*

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3-venv=3.11.2-1+b1 \
    && rm -rf /var/lib/apt/lists/*

COPY common/fs-bridge.mjs common/process-bridge.mjs common/command-bridge.mjs common/egress-bridge.mjs /usr/local/lib/pi-ipd/

RUN install -d -o 1000 -g 1000 /home/agent \
	&& chmod 0755 /usr/local/lib/pi-ipd/*-bridge.mjs

USER 1000:1000
WORKDIR /workspace
