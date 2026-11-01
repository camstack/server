#!/bin/sh
# CamStack CLI installer (D988) — Linux and macOS.
#
#   curl -fsSL https://camstack-docs.zentik.app/install.sh | sh
#
# Lays out the managed tree the CLI's `mcp update` / `mcp rollback` expect:
#
#   $CAMSTACK_HOME/runtime/          the Node the CLI runs on (only when the host Node is < 24)
#   $CAMSTACK_HOME/cli/<version>/    one staged CLI per version (npm --prefix)
#   $CAMSTACK_HOME/current           symlink to the active cli/<version>
#   $CAMSTACK_HOME/previous          symlink to the one before
#   $CAMSTACK_BIN_DIR/camstack       launcher
#
# It never asks for, reads or writes a credential: sign-in sessions live in
# ~/.camstack and are the CLI's business. No sudo. No secret through the
# environment or argv: the variables below only choose paths and versions.
#
#   CAMSTACK_HOME          default ~/.local/share/camstack
#   CAMSTACK_BIN_DIR       default ~/.local/bin
#   CAMSTACK_VERSION       default: the latest `camstack` on npm
#   CAMSTACK_NODE_DIST     default https://nodejs.org/dist (a mirror, for tests)
#   CAMSTACK_NPM_REGISTRY  default: npm's own configuration
set -eu

MIN_NODE_MAJOR=24
NODE_LINE="v${MIN_NODE_MAJOR}.x"

say() { printf '%s\n' "$*"; }
fail() { printf 'camstack installer: %s\n' "$*" >&2; exit 1; }

HOME_DIR="${HOME:-}"
[ -n "$HOME_DIR" ] || fail 'HOME is not set.'
ROOT="${CAMSTACK_HOME:-$HOME_DIR/.local/share/camstack}"
BIN_DIR="${CAMSTACK_BIN_DIR:-$HOME_DIR/.local/bin}"
NODE_DIST="${CAMSTACK_NODE_DIST:-https://nodejs.org/dist}"

case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  *) fail "unsupported system $(uname -s): Linux and macOS only (Windows: install Node ${MIN_NODE_MAJOR}, then npm i -g camstack)." ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64 ;;
  arm64 | aarch64) ARCH=arm64 ;;
  *) fail "unsupported CPU $(uname -m)." ;;
esac

have() { command -v "$1" >/dev/null 2>&1; }
have curl || fail 'curl is required.'
have tar || fail 'tar is required.'

sha256_of() {
  if have sha256sum; then sha256sum "$1" | cut -d' ' -f1
  elif have shasum; then shasum -a 256 "$1" | cut -d' ' -f1
  else fail 'sha256sum or shasum is required to verify the Node download.'
  fi
}

host_node_major() {
  have node || { echo 0; return; }
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

mkdir -p "$ROOT" "$BIN_DIR"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/camstack-install.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT INT TERM

# --- 1. runtime -------------------------------------------------------------
HOST_MAJOR="$(host_node_major)"
if [ "$HOST_MAJOR" -ge "$MIN_NODE_MAJOR" ] 2>/dev/null; then
  say "Using the Node already installed (v$HOST_MAJOR)."
else
  say "Node $MIN_NODE_MAJOR or newer not found (host: $HOST_MAJOR). Fetching the official Node $MIN_NODE_MAJOR."
  INDEX="$NODE_DIST/latest-$NODE_LINE/SHASUMS256.txt"
  curl -fsSL "$INDEX" -o "$TMP/SHASUMS256.txt" || fail "could not read $INDEX"
  ARCHIVE="$(grep -E " node-v[0-9.]+-$OS-$ARCH\.tar\.gz\$" "$TMP/SHASUMS256.txt" | awk '{print $2}' | head -n 1)"
  [ -n "$ARCHIVE" ] || fail "no Node build for $OS-$ARCH in $INDEX"
  WANT="$(grep -E " $ARCHIVE\$" "$TMP/SHASUMS256.txt" | awk '{print $1}' | head -n 1)"
  curl -fsSL "$NODE_DIST/latest-$NODE_LINE/$ARCHIVE" -o "$TMP/$ARCHIVE" || fail "could not download $ARCHIVE"
  GOT="$(sha256_of "$TMP/$ARCHIVE")"
  [ "$GOT" = "$WANT" ] || fail "sha256 mismatch for $ARCHIVE (expected $WANT, got $GOT); nothing was installed."
  mkdir -p "$TMP/node"
  tar -xzf "$TMP/$ARCHIVE" -C "$TMP/node" --strip-components=1
  rm -rf "$ROOT/runtime.new"
  mv "$TMP/node" "$ROOT/runtime.new"
  rm -rf "$ROOT/runtime"
  mv "$ROOT/runtime.new" "$ROOT/runtime"
  say "Node installed in $ROOT/runtime (sha256 verified)."
fi

if [ -x "$ROOT/runtime/bin/node" ]; then
  NODE="$ROOT/runtime/bin/node"
  NPM="$ROOT/runtime/bin/npm"
  PATH="$ROOT/runtime/bin:$PATH"
  export PATH
else
  NODE="$(command -v node)"
  NPM="$(command -v npm)" || fail 'npm was not found next to node.'
fi

# --- 2. the CLI -------------------------------------------------------------
VERSION="${CAMSTACK_VERSION:-}"
if [ -z "$VERSION" ]; then
  VERSION="$("$NPM" view camstack version 2>/dev/null)" || fail 'could not read the latest camstack version from npm; set CAMSTACK_VERSION.'
fi
case "$VERSION" in
  *[!0-9A-Za-z.-]* | '') fail "\"$VERSION\" is not a version." ;;
esac

STAGED="$ROOT/cli/$VERSION"
if [ ! -d "$STAGED/node_modules/camstack" ]; then
  mkdir -p "$STAGED"
  # A published package's install scripts never run on this machine.
  if ! "$NPM" install --prefix "$STAGED" "camstack@$VERSION" --no-audit --no-fund --ignore-scripts >"$TMP/npm.log" 2>&1; then
    rm -rf "$STAGED"
    cat "$TMP/npm.log" >&2
    fail "npm could not install camstack@$VERSION; nothing was changed."
  fi
fi
ENTRY="$STAGED/node_modules/camstack/dist/cli.js"
"$NODE" "$ENTRY" --version >/dev/null 2>&1 || fail "camstack@$VERSION does not start on this Node; the active version is unchanged."

# --- 3. switch the pointers atomically ---------------------------------------
swap_link() { # swap_link <link> <target>
  ln -sfn "$2" "$1.tmp.$$"
  mv -fh "$1.tmp.$$" "$1" 2>/dev/null || mv -fT "$1.tmp.$$" "$1"
}
if [ -L "$ROOT/current" ]; then
  BEFORE="$(readlink "$ROOT/current")"
  [ "$BEFORE" = "$STAGED" ] || swap_link "$ROOT/previous" "$BEFORE"
fi
swap_link "$ROOT/current" "$STAGED"

# --- 4. the launcher ----------------------------------------------------------
LAUNCHER="$BIN_DIR/camstack"
cat >"$LAUNCHER.tmp.$$" <<LAUNCH
#!/bin/sh
# Written by the CamStack installer. Uses the managed Node when there is one.
ROOT="$ROOT"
if [ -x "\$ROOT/runtime/bin/node" ]; then NODE="\$ROOT/runtime/bin/node"; else NODE="\$(command -v node)"; fi
exec "\$NODE" "\$ROOT/current/node_modules/camstack/dist/cli.js" "\$@"
LAUNCH
chmod 755 "$LAUNCHER.tmp.$$"
mv -f "$LAUNCHER.tmp.$$" "$LAUNCHER"

say "camstack $VERSION installed: $LAUNCHER"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "Add $BIN_DIR to your PATH, e.g.:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
say ''
say 'Next: camstack mcp doctor        check the install'
say '      camstack login <hub>      sign in (approve in your browser; no password is typed here)'
say '      camstack mcp update --latest | camstack mcp rollback'
