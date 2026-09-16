#!/usr/bin/env bash
set -euo pipefail

environment_root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

docker build \
  --file "${environment_root}/code-node24/Dockerfile" \
  --tag pi-ipd/code-node24:1.0.0 \
  "${environment_root}"

docker build \
  --file "${environment_root}/office-pptx/Dockerfile" \
  --tag pi-ipd/office-pptx:1.0.0 \
  "${environment_root}"
