#!/usr/bin/env bash
set -euo pipefail

environment_root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
general_image=${PI_IPD_GENERAL_IMAGE:-pi-ipd/general-purpose:1.0.0}
code_image=${PI_IPD_CODE_IMAGE:-pi-ipd/code-node24:1.0.0}
office_image=${PI_IPD_OFFICE_IMAGE:-pi-ipd/office-pptx:1.0.0}
node "${environment_root}/../../../scripts/generate-ipd-bridges.mjs" --check

docker build "$@" \
  --file "${environment_root}/general-purpose/Dockerfile" \
  --tag "${general_image}" \
  "${environment_root}"

docker build "$@" \
  --file "${environment_root}/code-node24/Dockerfile" \
  --tag "${code_image}" \
  "${environment_root}"

docker build "$@" \
  --build-arg "IPD_CODE_IMAGE=${code_image}" \
  --file "${environment_root}/office-pptx/Dockerfile" \
  --tag "${office_image}" \
  "${environment_root}"
