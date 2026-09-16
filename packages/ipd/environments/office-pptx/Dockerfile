# syntax=docker/dockerfile:1
FROM pi-ipd/code-node24:1.0.0

USER 0:0
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       fontconfig=2.14.1-4 fonts-liberation=1:1.07.4-11 fonts-noto-cjk=1:20220127+repack1-1 \
       libreoffice-impress=4:7.4.7-1+deb12u14 poppler-utils=22.12.0-2+deb12u3 \
       python3-pip=23.0.1+dfsg-1 python3-venv=3.11.2-1+b1 \
    && rm -rf /var/lib/apt/lists/*

COPY office-pptx/package.json office-pptx/package-lock.json /opt/pi-ipd/node/
COPY office-pptx/requirements.lock /opt/pi-ipd/requirements.lock

RUN npm ci --prefix /opt/pi-ipd/node --ignore-scripts \
    && python3 -m venv /opt/pi-ipd/venv \
    && /opt/pi-ipd/venv/bin/pip install --no-cache-dir -r /opt/pi-ipd/requirements.lock

ENV PATH="/opt/pi-ipd/venv/bin:/usr/local/bin:/usr/bin:/bin"
ENV NODE_PATH="/opt/pi-ipd/node/node_modules"

USER 1000:1000
WORKDIR /workspace
