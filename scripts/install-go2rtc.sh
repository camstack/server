#!/bin/bash
# Download go2rtc binary for the current platform.
# Usage: ./scripts/install-go2rtc.sh [version]
#
# Places the binary in ./bin/go2rtc (gitignored).
# The proxy expects GO2RTC_PATH=./bin/go2rtc in .env.

set -euo pipefail

VERSION="${1:-1.9.14}"
BASE_URL="https://github.com/AlexxIT/go2rtc/releases/download/v${VERSION}"

OS="$(uname -s)"
ARCH="$(uname -m)"

case "${ARCH}" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  armv7*|armhf)  ARCH="arm" ;;
  i386|i686)     ARCH="i386" ;;
  *)
    echo "❌ Unsupported architecture: ${ARCH}"
    exit 1
    ;;
esac

case "${OS}" in
  Darwin)
    # macOS: go2rtc_mac_{arch}.zip
    FILENAME="go2rtc_mac_${ARCH}.zip"
    IS_ZIP=true
    ;;
  Linux)
    # Linux: go2rtc_linux_{arch} (raw binary, no zip)
    FILENAME="go2rtc_linux_${ARCH}"
    IS_ZIP=false
    ;;
  *)
    echo "❌ Unsupported OS: ${OS}"
    exit 1
    ;;
esac

URL="${BASE_URL}/${FILENAME}"

mkdir -p bin

echo "📦 Downloading go2rtc v${VERSION} for ${OS}/${ARCH}..."
echo "   ${URL}"

if [ "${IS_ZIP}" = true ]; then
  TMPZIP="$(mktemp)"
  curl -fSL -o "${TMPZIP}" "${URL}"
  unzip -o -q "${TMPZIP}" -d bin/
  rm -f "${TMPZIP}"
  # The zip contains a single binary named go2rtc (or go2rtc.exe)
  chmod +x bin/go2rtc
else
  curl -fSL -o bin/go2rtc "${URL}"
  chmod +x bin/go2rtc
fi

echo ""
echo "✅ go2rtc v${VERSION} installed to ./bin/go2rtc"
./bin/go2rtc --version 2>/dev/null || true
echo ""
echo "Add to .env:"
echo "  GO2RTC_PATH=./bin/go2rtc"
