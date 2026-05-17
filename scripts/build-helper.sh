#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../go"
GOOSARCH=("darwin/amd64" "darwin/arm64" "linux/amd64" "linux/arm64" "windows/amd64" "windows/arm64")
mkdir -p ../bin
for osarch in "${GOOSARCH[@]}"; do
  IFS=/ read -r GOOS GOARCH <<< "$osarch"
  out=../bin/bolthelper-$GOOS-$GOARCH
  [ "$GOOS" = "windows" ] && out+='.exe'
  echo "Building $out"
  GOOS=$GOOS GOARCH=$GOARCH CGO_ENABLED=0 go build -ldflags="-s -w" -o "$out" ./cmd/bolthelper
  [ "$GOOS" != "windows" ] && chmod +x "$out"
done
echo "Build completed successfully"
