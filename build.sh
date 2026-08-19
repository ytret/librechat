#!/usr/bin/env bash

set -euxo pipefail

docker build -t librechat:latest \
  --build-arg BUILD_COMMIT=$(git rev-parse HEAD) \
  --build-arg BUILD_BRANCH=$(git rev-parse --abbrev-ref HEAD) \
  --build-arg BUILD_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ") .
