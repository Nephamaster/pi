# syntax=docker/dockerfile:1
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS node-runtime
FROM python:3.12.14-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e

ARG DEBIAN_MIRROR=http://deb.debian.org/debian
ARG DEBIAN_SECURITY_MIRROR=http://deb.debian.org/debian-security
ARG PIP_INDEX_URL=https://pypi.org/simple

RUN sed -i \
      -e "s|http://deb.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g" \
      -e "s|http://deb.debian.org/debian|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       bash build-essential ca-certificates git curl wget ripgrep findutils \
       jq sqlite3 file patch diffutils procps tar gzip bzip2 xz-utils zip unzip \
    && rm -rf /var/lib/apt/lists/*

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=node-runtime /usr/local/include/node /usr/local/include/node
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

COPY general-purpose/requirements.lock /opt/pi-ipd/requirements.lock
RUN python3 -m pip install --no-cache-dir --only-binary=:all: --index-url "${PIP_INDEX_URL}" \
      -r /opt/pi-ipd/requirements.lock \
    && python3 -m pip check

COPY common/fs-bridge.mjs common/process-bridge.mjs common/command-bridge.mjs common/egress-bridge.mjs /usr/local/lib/pi-ipd/
RUN install -d -o 1000 -g 1000 /home/agent \
    && chmod 0755 /usr/local/lib/pi-ipd/*-bridge.mjs \
    && dpkg-query -W > /opt/pi-ipd/system-packages.txt

ENV PATH="/usr/local/bin:/usr/bin:/bin"
ENV LANG=C.UTF-8
USER 1000:1000
WORKDIR /workspace
