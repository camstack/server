#!/bin/bash
set -euo pipefail

VERSION="${1:?Usage: build-tarball.sh VERSION PLATFORM ARCH}"
PLATFORM="${2:?}"   # darwin, linux
ARCH="${3:?}"       # arm64, x64

NODE_VERSION="22.14.0"
TARBALL_NAME="camstack-v${VERSION}-${PLATFORM}-${ARCH}"
BUILD_DIR="dist/${TARBALL_NAME}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Building ${TARBALL_NAME}"
echo "    Node.js: v${NODE_VERSION}"
echo "    Root: ${ROOT_DIR}"

# 1. Clean
rm -rf "${BUILD_DIR}"
mkdir -p "${BUILD_DIR}"/{bin,node/bin,cli,data,deps}

# 2. Download Node.js binary for target platform
NODE_ARCH="${ARCH}"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${PLATFORM}-${NODE_ARCH}.tar.gz"
echo "==> Downloading Node.js from ${NODE_URL}"

TEMP_NODE="$(mktemp -d)"
curl -sL "${NODE_URL}" | tar xz --strip-components=1 -C "${TEMP_NODE}"
cp "${TEMP_NODE}/bin/node" "${BUILD_DIR}/node/bin/node"
chmod +x "${BUILD_DIR}/node/bin/node"
rm -rf "${TEMP_NODE}"

# 3. Build all packages
echo "==> Building packages..."
cd "${ROOT_DIR}"
npm ci
npm run build

# 4. Copy built server
echo "==> Copying server..."
mkdir -p "${BUILD_DIR}/app"
cp -r server/backend/dist "${BUILD_DIR}/app/server"

# 5. Copy built packages (only dist dirs + package.json)
echo "==> Copying packages..."
for pkg_dir in packages/*/; do
  pkg_name="$(basename "${pkg_dir}")"
  if [ -d "${pkg_dir}dist" ]; then
    mkdir -p "${BUILD_DIR}/app/packages/${pkg_name}"
    cp -r "${pkg_dir}dist" "${BUILD_DIR}/app/packages/${pkg_name}/dist"
    [ -f "${pkg_dir}package.json" ] && cp "${pkg_dir}package.json" "${BUILD_DIR}/app/packages/${pkg_name}/"
  fi
done

# 6. Copy root package files for npm ci
cp package.json "${BUILD_DIR}/app/"
cp package-lock.json "${BUILD_DIR}/app/"

# 7. Install production dependencies
echo "==> Installing production dependencies..."
cd "${BUILD_DIR}/app"
"${ROOT_DIR}/${BUILD_DIR}/node/bin/node" "$(command -v npm)" ci --production --ignore-scripts 2>/dev/null || \
  npm ci --production --ignore-scripts
cd "${ROOT_DIR}"

# 8. Copy CLI output and shell wrapper
echo "==> Copying CLI..."
cp packages/cli/dist/cli.js "${BUILD_DIR}/cli/"
cp bin/camstack "${BUILD_DIR}/bin/"
chmod +x "${BUILD_DIR}/bin/camstack"

# 9. Create tarball
echo "==> Creating tarball..."
cd dist
tar czf "${TARBALL_NAME}.tar.gz" "${TARBALL_NAME}"
TARBALL_SIZE="$(du -sh "${TARBALL_NAME}.tar.gz" | cut -f1)"
echo "==> Built: dist/${TARBALL_NAME}.tar.gz (${TARBALL_SIZE})"
