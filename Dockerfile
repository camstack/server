# syntax=docker/dockerfile:1
# =============================================================================
# CamStack Hub — Docker image (REGISTRY-INSTALL model)
#
# The @camstack/* packages are PUBLIC on npm (registry.npmjs.org, --access
# public) and published WITH their built dist (addon-pipeline ships
# python/wasm/swift too) + native PREBUILDS (better-sqlite3/sharp
# are linux-x64 prebuilt). So the image is assembled by INSTALLING the
# already-built closure from npm — NO source build, NO nx, NO toolchain, NO
# `COPY` of the monorepo. This is the single-canonical-artifact model: every
# deploy target consumes the byte-identical published package.
#
# Stage 1 is a THIN fetch (node:24 just for npm) — it does `npm install` of the
# pre-built closure + bakes the framework + addon seed dirs FROM npm (same
# layout the workspace build produced, sourced from the registry instead).
# Stage 2 is a shared runtime (`runtime-common`); final targets `intel` and
# `amd` add the vendor VA / GPU / NPU stack. `docker build` without `--target`
# yields `intel` (last stage). CI builds both via the release matrix.
#
# PRODUCT_VERSION is the product release (image tag / desktop app), not an
# npm version. The closure installed below is `@camstack/server@latest`.
# The runtime stage re-declares PRODUCT_VERSION as CAMSTACK_PRODUCT_VERSION
# so the About line can show it next to the running server package (D943).
# =============================================================================

# ── Stage 1 — fetch the PRE-BUILT closure from npm (no build, no toolchain) ───
FROM node:24 AS fetch
WORKDIR /opt
ENV CI=true

# 0) Hub run-dir: install @camstack/server@latest — pulls the WHOLE hub closure
#    (server + system/types/sdk/ui-library + the bootstrap addons +
#    every third-party dep + native linux prebuilds). The launcher runs from
#    here: node_modules/@camstack/server/dist/launcher.js.
#    NEVER pin to the product version: packages are published to npm on their
#    own line, and per-package versions drift. `@latest` is the closure this
#    image bakes; the product tag is only the image label (intel-X.Y.Z).
RUN mkdir -p /opt/camstack-hub && cd /opt/camstack-hub && \
    npm init -y >/dev/null && \
    npm install --omit=dev --no-audit --no-fund "@camstack/server@latest" && \
    test -e node_modules/@camstack/server/dist/launcher.js && \
    test -e node_modules/@camstack/server/dist/starter.js

# 1) NO SECOND SEED TREE.
#    There used to be a second baked framework tree under `/opt` here (removed
#    2026-08-25; the path is in git history and in
#    `docs/design/2026-08-13-single-copy-addons-first-boot-install.md` §4.4,
#    which had already filed it as a candidate and left it "for now"): a SECOND
#    npm install of the same `@camstack/{system,types,sdk}` plus the hoisted
#    natives, existing only to be copied into `$FRAMEWORK_DIR` on the fallback
#    boot. Measured on the live image 2026-08-25 it was 510 MB beside a 930 MB
#    `/opt/camstack-hub` — and it was the THIRD copy of every framework package,
#    which is what made the D45 inventory report three where the design allows
#    two.
#
#    Redundant by inspection: `/opt/camstack-hub/node_modules` already hoists
#    `better-sqlite3`, `node-av`, `sharp` and `zod` at its root — the exact
#    reason the second tree was built that way — and already holds
#    `@camstack/sdk`, `system` and `types` as dependencies of `@camstack/server`.
#    The fallback now takes the framework subset from that one tree; see the
#    entrypoint.
#
#    On the ideal of a single copy: the seed CANNOT be baked at the position the
#    runtime expects. `$FRAMEWORK_DIR` lives under `/data`, a mounted volume, so
#    anything written there at build time is hidden by the mount. One tree in
#    `/opt` plus one runtime copy under `/data` is the floor.

# NO ADDON SEED. Every non-system addon is single-copy, always, installed from
#    npm during the initial boot (operator, 2026-08-12: "tutti gli altri addons
#    devono rimanere copia unica, sempre, installati durante l'avvio iniziale").
#    The image used to bake each bootstrap addon into its own dir under /opt and
#    the entrypoint copied them into /data on a fresh volume — which gave every
#    one of them TWO truthful versions on one node (the live hub: seed
#    addon-pipeline 1.2.64 against 1.2.69 installed, admin-ui 1.2.47 against
#    1.2.50). `AddonInstaller.ensureRequiredPackages` already fetches a missing
#    bootstrap package from the registry, so removing the tree removes an
#    answer, not a mechanism. The SYSTEM seed above stays: it is the fallback a
#    node boots from when its closure is broken.

# ── Stage 2 — shared runtime (ubuntu:24.04); vendor stacks in `intel` / `amd` ─
FROM ubuntu:24.04 AS runtime-common
LABEL org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/camstack/server" \
      org.opencontainers.image.description="CamStack. Model weights are downloaded at runtime under their own licences: /usr/share/doc/camstack/THIRD_PARTY_MODELS.md"

# Base OS + libva (no vendor VA driver yet — those land in the `intel` / `amd`
# final stages). gnupg stays: the intel stage needs it for the Intel GPU apt key.
# fontconfig + DejaVu: sharp/librsvg SVG overlays (timelapse preview titles,
# snapshot courtesy frames) name font families; without them every glyph is tofu.
# libusb-1.0-0: the libedgetpu "std" delegate links libusb even for a PCIe/M.2
# Coral, so without it `load_delegate(…, {'device': 'pci:0'})` fails with
# "libusb-1.0.so.0: cannot open shared object file" (the AMD image on
# agent-b, 2026-10-21). In the shared stage so EVERY image variant has it;
# the edgetpu installer also drops a copy beside the delegate for older images.
RUN apt-get update && apt-get install -y --no-install-recommends \
      gosu curl gnupg openssl procps ca-certificates tini unzip xz-utils libstdc++6 \
      python3 make g++ libva-drm2 libva2 vainfo libusb-1.0-0 \
      fontconfig fonts-dejavu-core && \
    rm -rf /var/lib/apt/lists/* && chmod 1777 /tmp

# NO ffmpeg in this image, deliberately — and this is the second decision on
# that line in two days, so the reasoning is worth keeping.
#
# It WAS installed here, linked at /opt/camstack/bin/ffmpeg, because a path only
# this image writes is the one way a process can tell "our binary" from "the
# host's" (D536, and /usr/bin/ffmpeg is both depending on where you stand). That
# worked, and it made the answer depend on WHERE A NODE RUNS: an image node got
# VAAPI, a native one got a portable build with none, and changing the ffmpeg
# version meant rebuilding and rolling this image on every machine.
#
# So every node now downloads the same pinned build instead
# (packages/types/src/deps/ffmpeg-artifacts.ts). The version becomes data rather
# than code, one binary answers everywhere, and — since we ship no ffmpeg — we
# convey no GPL work: the node fetches the archive from the project that
# publishes it.
#
# What an image CANNOT delegate is the drivers. libva is here; the vendor
# `*_drv_video.so` is added by the `intel` / `amd` stages. Measured 2026-09-19 —
# the portable build encodes VAAPI inside this container and ABORTS on the bare
# host, where libva-drm.so.2 does not exist.

# `btm` (bottom) — the process/resource monitor the terminal addon's `monitor`
# profile spawns. Not in the Ubuntu repos, so pull the pinned release .deb.
ARG BOTTOM_VERSION=0.14.7
RUN curl -fsSL -o /tmp/bottom.deb \
      "https://github.com/ClementTsang/bottom/releases/download/${BOTTOM_VERSION}/bottom_${BOTTOM_VERSION}-1_amd64.deb" && \
    dpkg -i /tmp/bottom.deb && rm /tmp/bottom.deb && btm --version

# Node 24 toolchain from the official node:24 image (binary + bundled modules).
COPY --from=fetch /usr/local/bin/node /usr/local/bin/node
COPY --from=fetch /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx && \
    ln -sf ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack

# The hub run-dir (server closure) + the two seed closures, all baked from npm.
COPY --from=fetch /opt/camstack-hub /opt/camstack-hub

# Privileged package helper (D326). Image-baked on purpose: applyServerUpdate
# must not replace a root process. The allowlist is the same file the CI
# guard diffs against packages/system/.../system-package-allowlist.ts.
COPY scripts/docker/camstack-pkgd.mjs /usr/local/bin/camstack-pkgd.mjs
COPY scripts/docker/pkg-allowlist.json /usr/local/share/camstack/pkg-allowlist.json
# VA driver vs libva ABI check (D926). Run by the `intel` / `amd` stages at
# build time; also runnable by hand in a container with /dev/dri, where it
# exercises vaInitialize through `vainfo`.
COPY scripts/docker/check-libva-abi.sh /usr/local/bin/camstack-check-libva-abi.sh

# Licence notices travel with the image: CamStack's own LICENSE, the notice for
# every model a node can download (THIRD_PARTY_MODELS.md), and the full licence
# texts it cites. Copied from the build context of the commit being built (they
# are whitelisted in .dockerignore), so the image carries them without waiting
# for a @camstack/server publish; the npm closure carries its own copy of the
# notice (server/backend/THIRD_PARTY_MODELS.md).
COPY LICENSE THIRD_PARTY_MODELS.md /usr/share/doc/camstack/
COPY licenses/models/ /usr/share/doc/camstack/licenses/models/

RUN groupadd -g 1001 camstack && \
    useradd -u 1001 -g camstack -m -s /usr/sbin/nologin camstack && \
    chown -R camstack:camstack /opt/camstack-hub && \
    mkdir -p /data /config /backups && chown -R camstack:camstack /data /config /backups

# Seed VERSION fingerprint (content hash of every baked @camstack/* JS) — the
# entrypoint re-seeds /data on an image upgrade when this differs.
# Hashed over the ONE baked tree: it used to cover only `system`/`types`/`sdk`,
# now it covers every baked `@camstack/*` — which is what the line above always
# claimed. It therefore moves on more changes than before, the conservative
# direction: a re-seed too many costs a copy, a re-seed too few leaves a node
# booting old code out of `/data`.
RUN find /opt/camstack-hub/node_modules/@camstack \
      -type f \( -name '*.js' -o -name '*.mjs' \) -exec md5sum {} + 2>/dev/null \
      | md5sum | cut -d' ' -f1 > /opt/camstack-seed-version \
    && echo "[build] seed version: $(cat /opt/camstack-seed-version)"

# Vendor LIBVA pin lives only on the `intel` stage (`LIBVA_DRIVER_NAME=iHD`).
# The `amd` stage leaves libva to auto-select `radeonsi` from mesa-va-drivers.
# Product release (0.1.0, …). Empty in a local build that did not pass it.
# Not the npm version of the closure — that is the running package.json.
ARG PRODUCT_VERSION=
ENV CAMSTACK_PRODUCT_VERSION=${PRODUCT_VERSION}
ENV NODE_ENV=production
ENV CAMSTACK_DATA=/data
ENV CONFIG_PATH=/config/config.yaml
ENV CAMSTACK_ADDONS_DIR=/data/addons
# NO static CAMSTACK_FRAMEWORK_DIR / NODE_PATH. A tree that sits on NODE_PATH is
# a live resolution path the single-copy sweep must refuse to remove — so baking
# these two froze `/data/framework` on every node forever, sweep or no sweep.
# The entrypoint exports BOTH only in the FALLBACK boot that actually seeds the
# tree (no active closure); a healthy boot resolves from server-root/current and
# leaves the leftover tree sweepable.
# Dedicated backup volume (default). Backup archives seed here (via the
# `backups` storage location's `defaultRoot: 'backup'`) so they live on their
# own mount instead of filling the appData /data disk. Operators can repoint
# the location or override this env; unset falls the seed back to /data.
ENV CAMSTACK_BACKUP_ROOT=/backups
# NO CAMSTACK_BUNDLED_ADDONS_DIR. It named the baked addon tree, and the launcher
# resolves `installSource: 'local'` whenever it points at a directory that
# exists — so it must leave with the tree, in the same image. Left behind, it
# would send the bootstrap looking for a copy that is no longer there.
# Runtime-updatable root package (2026-07-12 design): the baked closure is the
# immutable SEED. The STARTER (entrypoint CMD below) boots the active
# `@camstack/server` root from /data/server-root when present + healthy, else
# falls back to this seed. The env names the seed dir so the starter's
# fallback and the server-management status cap (seedVersion) can find it.
ENV CAMSTACK_SEED_SERVER_DIR=/opt/camstack-hub/node_modules/@camstack/server

# Role selector (2026-07 single-image collapse): one image serves both roles.
# `hub` (default) boots the full Fastify hub on 4443; `agent` boots the
# lightweight agent status API on CAMSTACK_STATUS_PORT (default 4444). The
# starter/launcher branch on this env; the healthcheck below is role-aware.
ENV CAMSTACK_ROLE=hub

# No WebRTC port: werift binds an OS-ephemeral UDP port per session (no
# icePortRange, no ICE-TCP), so there is nothing fixed to publish. 1984/8555
# were restreamer's and nothing in the image listens on them.
# Mesh: mutual TLS on 6443 for hub AND enrolled agents (D826, D848); the clear
# 6000 and an agent's derived clear port (20000-29999) are retired.
EXPOSE 4443 8554 6443/tcp
# Agent status API port (role=agent).
EXPOSE 4444

# Role-aware healthcheck: hub probes /health on CAMSTACK_PORT (default 4443),
# over HTTPS unless CAMSTACK_TLS_ENABLED says otherwise (the server reads any
# value but "true" as off); agent probes its plain-HTTP /health on
# CAMSTACK_STATUS_PORT (default 4444).
COPY <<'EOF' /usr/local/bin/camstack-healthcheck.sh
#!/bin/sh
if [ "$CAMSTACK_ROLE" = "agent" ]; then
  exec curl -fsS --max-time 20 "http://localhost:${CAMSTACK_STATUS_PORT:-4444}/health" -o /dev/null
fi
if [ -n "$CAMSTACK_TLS_ENABLED" ] && [ "$CAMSTACK_TLS_ENABLED" != "true" ]; then
  exec curl -fsS --max-time 20 "http://localhost:${CAMSTACK_PORT:-4443}/health" -o /dev/null
fi
exec curl -fsSk --max-time 20 "https://localhost:${CAMSTACK_PORT:-4443}/health" -o /dev/null
EOF
RUN chmod +x /usr/local/bin/camstack-healthcheck.sh
HEALTHCHECK --interval=30s --timeout=25s --start-period=180s --retries=5 \
    CMD /usr/local/bin/camstack-healthcheck.sh
VOLUME ["/data", "/config", "/backups"]

COPY <<'EOF' /usr/local/bin/docker-entrypoint.sh
#!/bin/sh
set -e
DATA_DIR="${CAMSTACK_DATA:-/data}"
CONFIG_DIR="$(dirname "${CONFIG_PATH:-/config/config.yaml}")"
FRAMEWORK_DIR="${CAMSTACK_FRAMEWORK_DIR:-$DATA_DIR/framework}"
ADDONS_DIR="${CAMSTACK_ADDONS_DIR:-$DATA_DIR/addons}"
# NOTE: `$FRAMEWORK_DIR/node_modules` is deliberately NOT created here. An empty
# directory is harmless, but re-creating it every restart is what made the
# legacy tree impossible to retire; the fallback block below creates it on the
# one path that needs it.
mkdir -p "$DATA_DIR" "$CONFIG_DIR" "$ADDONS_DIR/@camstack"

# WHICH BACKEND IS ABOUT TO RUN — and does that copy carry the post-boot sweep?
#
# The image NEVER contains this repo's backend: the Dockerfile installs
# `@camstack/server@latest` from npm, and the starter then prefers
# `server-root/current`. So a backend change is TRAIN-BOUND by construction —
# building an image from a commit does not ship that commit's server code.
# On 2026-08-13 that cost a diagnosis: the agent was recreated on an image built
# from the commit carrying the single-copy sweep, the sweep never ran, and
# nothing said why — the published 1.2.101 the image installed predates it.
# Silence is the failure here, so the entrypoint states the capability before
# Node starts. It reports; it never gates.
ACTIVE_SERVER="$DATA_DIR/server-root/current/node_modules/@camstack/server"
[ -e "$ACTIVE_SERVER/package.json" ] || ACTIVE_SERVER="${CAMSTACK_SEED_SERVER_DIR:-/opt/camstack-hub/node_modules/@camstack/server}"
SERVER_VERSION="$(node -p "require('$ACTIVE_SERVER/package.json').version" 2>/dev/null || echo unknown)"
if [ -e "$ACTIVE_SERVER/dist/single-copy-cleanup.js" ]; then
  echo "[entrypoint] backend @camstack/server@$SERVER_VERSION from $ACTIVE_SERVER — post-boot single-copy sweep PRESENT"
else
  echo "[entrypoint] backend @camstack/server@$SERVER_VERSION from $ACTIVE_SERVER — post-boot single-copy sweep ABSENT; the redundant data-side copies WILL REMAIN this boot (the sweep ships in a published @camstack/server, never in an image build)"
fi

SEED_VERSION="$(cat /opt/camstack-seed-version 2>/dev/null || echo unknown)"
RECORDED_VERSION="$(cat "$DATA_DIR/.camstack-seed-version" 2>/dev/null || echo none)"

# THE FRAMEWORK FALLBACK — recreated only when the closure is BROKEN.
#
# `/data/framework` used to be re-seeded whenever it was missing, which made it
# impossible to remove: the post-boot single-copy sweep deleted it and the next
# container restart put all 509 MB straight back, on the module search path — a
# second answer to "which @camstack/system is this node running". Operator,
# 2026-08-13: one version of everything per node, and the recreation is only the
# explicit fallback path for a broken closure — logged loudly.
#
# So the ONE condition is: the active closure has no @camstack/system. That is
# a genuinely fresh /data (before the first applyServerUpdate) or a closure that
# did not survive an update — exactly the two boots that would otherwise fail.
# In steady state this block does nothing and `/data/framework` stays gone.
#
# The bootstrap ADDON seed is gone entirely: every non-system addon is installed
# from npm at first boot, single-copy, by the launcher.
DATA_ROOT_SYSTEM="$DATA_DIR/server-root/current/node_modules/@camstack/system/package.json"
NEED_FRAMEWORK=0
if [ ! -e "$DATA_ROOT_SYSTEM" ]; then
  NEED_FRAMEWORK=1
fi

if [ "$NEED_FRAMEWORK" = 1 ]; then
  echo "[entrypoint] FALLBACK: no active closure at $DATA_ROOT_SYSTEM"
  echo "[entrypoint] FALLBACK: seeding the baked framework into $FRAMEWORK_DIR so this node can boot (recorded=$RECORDED_VERSION image=$SEED_VERSION)"
  mkdir -p "$FRAMEWORK_DIR/node_modules"
  # Seeded from the ONE baked tree: everything third-party comes over as-is (the
  # natives and `zod` are already hoisted at its root — that hoisting is the
  # whole reason a second tree used to exist), then the `@camstack` scope is
  # narrowed to the three framework packages.
  #
  # The scope is REPLACED, not merged: copying `@camstack` wholesale would put
  # `@camstack/server` and every baked addon into the framework dir — a fresh
  # set of shadow copies, the exact fault D45 names.
  cp -a /opt/camstack-hub/node_modules/. "$FRAMEWORK_DIR/node_modules/"
  rm -rf "$FRAMEWORK_DIR/node_modules/@camstack"
  mkdir -p "$FRAMEWORK_DIR/node_modules/@camstack"
  for pkg in system types sdk; do
    src="/opt/camstack-hub/node_modules/@camstack/$pkg"
    # A missing framework package is fatal for this boot and must say so: the
    # node would otherwise start and then fail resolution with an error that
    # names nothing.
    [ -d "$src" ] || { echo "[entrypoint] FALLBACK FATAL: $src missing from the baked seed"; exit 1; }
    cp -a "$src" "$FRAMEWORK_DIR/node_modules/@camstack/"
  done
  printf '%s' "$SEED_VERSION" > "$DATA_DIR/.camstack-seed-version"
  # ONLY this boot resolves from the seeded tree. A healthy boot never exports
  # these, so a leftover /data/framework is off NODE_PATH and the single-copy
  # sweep may remove it.
  export CAMSTACK_FRAMEWORK_DIR="$FRAMEWORK_DIR"
  export NODE_PATH="$FRAMEWORK_DIR/node_modules"
  echo "[entrypoint] FALLBACK: NODE_PATH=$NODE_PATH exported for this boot only"
fi

# The data volume contains recordings and media. Recursively walking it on
# every container start made an otherwise healthy reboot spend minutes in
# chown before Node could even open the health port. Runtime-created content
# is already owned by `camstack`; only repair the mount roots and content that
# this root entrypoint may have seeded itself.
#
# `$ADDONS_DIR/@camstack` is created above as root via `mkdir -p`. A
# non-recursive chown of `$ADDONS_DIR` alone leaves the scope dir root-owned,
# and the `camstack` process then cannot seed AGENT_PACKAGES into it (fresh
# AMD Proxmox agent 2026-10-10: empty /data/addons/@camstack, pipeline page
# blank). Own the scope dir explicitly — still O(1), not a media-tree walk.
for owned_path in "$DATA_DIR" "$CONFIG_DIR" "$FRAMEWORK_DIR" "$ADDONS_DIR" "$ADDONS_DIR/@camstack" "${CONFIG_PATH:-/config/config.yaml}"; do
  [ -e "$owned_path" ] && chown camstack:camstack "$owned_path" 2>/dev/null || true
done
[ "$NEED_FRAMEWORK" = 1 ] && chown -R camstack:camstack "$FRAMEWORK_DIR" 2>/dev/null || true
# A media or backup MOUNT ROOT the camstack user cannot write. A fresh bind is
# usually root:root 0755 (dev hub CT200, 2026-10-23: EACCES on
# /recordings/artifacts, recordings would have failed). Only the mount root and
# only when `camstack` cannot write it: never a walk of the media tree, and a
# share the operator already made writable (an Unraid user share) is left as is.
# A root this cannot fix (read-only, root-squashed NFS) is reported by the hub's
# storage-root liveness check at boot.
for media_root in "${CAMSTACK_MEDIA_ROOT:-}" "${CAMSTACK_BACKUP_ROOT:-}"; do
  [ -n "$media_root" ] && [ -d "$media_root" ] || continue
  if ! gosu camstack:camstack test -w "$media_root" -a -x "$media_root"; then
    echo "[entrypoint] $media_root is not writable by camstack ($(stat -c '%u:%g %a' "$media_root" 2>/dev/null)) — taking ownership of the mount root"
    chown camstack:camstack "$media_root" 2>/dev/null \
      || echo "[entrypoint] could not chown $media_root (read-only or root-squashed mount) — the hub will report it at boot"
  fi
done
# Explicit recovery escape hatch for a volume imported with foreign ownership.
# This is intentionally opt-in because it traverses the complete media tree.
if [ "${CAMSTACK_REPAIR_PERMISSIONS:-0}" = "1" ]; then
  echo "[entrypoint] Repairing data/config ownership recursively"
  chown -R camstack:camstack "$DATA_DIR" "$CONFIG_DIR" 2>/dev/null || true
fi
# Accelerator device nodes must be OPENABLE by `camstack`, and `gosu` below
# drops every supplementary group — a compose `group_add: [render, video]`
# reaches only this root shell, never Node or the Python inference pool. The
# loop used to name `/dev/accel/render*` (a path that does not exist) instead
# of `/dev/dri/render*`, so on the AMD Proxmox agent the WebGPU children ran
# for a week with `Groups:` empty, `open(/dev/dri/renderD128)` = EACCES, and
# Dawn silently served every "webgpu" session from a software path at 15× the
# GPU latency (yolov9t-320: 224 ms vs 13 ms, gpu_busy 0 %) — measured
# 2026-10-13, `docs/benchmarks/2026-10-13-phoenix-npu-and-igpu.md`. The
# container's /dev is its own tmpfs, so the chown never touches the host node.
# `/dev/apex_*` is a PCIe/M.2 Coral: an LXC `gid=993,mode=0660` or a host
# `apex` group reaches only root here, exactly like `render` above.
for dev in /dev/accel/accel* /dev/dri/renderD* /dev/dri/card* /dev/apex_*; do
  [ -e "$dev" ] && chown camstack:camstack "$dev" 2>/dev/null || true
done
# Coral EdgeTPU plug-and-play: the server runs as non-root `camstack`, but USB
# device nodes typically arrive root:root 664 — libusb needs rw to claim the
# device, so the edgetpu delegate silently fails to load (observed live
# 2026-07-22: every frame shed, camera blind). The entrypoint still runs as
# root and /dev/bus/usb is bind-mounted from the host, so fix the perms HERE —
# no host udev rule needed on any install. Match only Coral ids (1a6e:089a
# unflashed / 18d1:9302 flashed) by reading idVendor/idProduct straight from
# the device descriptor (bytes 8-11, little-endian). Mid-run replug still
# needs a container restart (or a host udev rule) — boot-time covers the
# normal restart/upgrade paths.
for dev in /dev/bus/usb/*/*; do
  [ -c "$dev" ] || continue
  ids="$(od -A n -t x1 -j 8 -N 4 "$dev" 2>/dev/null | tr -d ' \n')"
  case "$ids" in
    6e1a9a08|d1180293) chmod 666 "$dev" 2>/dev/null || true ;;
  esac
done
# The node's launch parameters (heap ceiling, native allocator env) are decided
# by the SERVER CLOSURE, not by this image: `dist/launch-args.js` prints them and
# the block below only executes what it printed (ADR 0970). hub-main still gets
# NO hardcoded heap cap — that module returns V8's default for the hub unless a
# per-node override or CAMSTACK_HUB_HEAP_MB is set. The history below is why.
#
# It used to be a hard `--max-old-space-size=1536`, and that number killed the
# hub four times in ~15h on 2026-08-01/02 — once nine seconds after a viewer
# opened a WebRTC session, which is why the app hung in a permanent "loading":
# the hub was dying as it connected. The `[mem] hub-main` heartbeat then showed
# it was NOT a leak (heap trend -85MB over 6 min) but a stable sawtooth peaking
# at 1099MB against V8's real 1728MB ceiling — 64% used, ~600MB left for a
# burst, and a WebRTC session or a boot storm is bigger than that.
#
# Measured in this very container before removing it:
#   - Node's DEFAULT heap limit here is 4288MB — larger than any number we were
#     going to hand-pick (3072 gave 3264MB), and still BOUNDED. There is no
#     "unlimited": dropping the flag does not remove a ceiling, it picks a
#     better one.
#   - The container is capped at 24GB and sits at ~38%, and its cgroup has
#     never OOM-killed anything (`oom_kill 0`), so a runaway still cannot take
#     the host or its neighbours down.
#   - Forked runners already ship with NO old-space cap by default
#     (`runnerHeapFlags`, unless a manifest declares one) — hub-main
#     was the lone hardcoded exception, and it was the only process that OOM'd.
#
# The safety net is no longer a guessed constant: V8's own bound still ends a
# runaway with a graceful fatal, the 24GB cgroup protects the box, and the
# `[mem] hub-main` heartbeat warns at 80% of whatever ceiling is actually in
# effect (it reads heap_size_limit at runtime, so it adapts to this default or
# to an operator override).
#
# ## 2026-08-25 — what the default actually costs, measured
#
# `CAMSTACK_HUB_HEAP_MB` is UNSET on the live hub, so pid 7's argv is a bare
# `node .../starter.js` and the ceiling in force is V8's host-derived 4288MB.
# The heap never approaches it: 31 consecutive `[mem]` samples over 55 minutes
# read heapUsed p50 ~1.27GB and max 2453MB — 57% — against RSS of 3.4-3.9GB.
# So the default ceiling is not what OOMs this process and a cap is NOT the fix
# for the RSS; what a cap buys is EARLIER mark-compacts, and a mark-compact is
# what sweeps the dead `arrayBuffers` (every reclaim on the record drops them
# from 200-380MB to ~12MB). The host itself is the reason to want that: 63.7GB
# total, 56.0GB used, 3.3GB free, and NO swap.
#
# Recommended value when the container is next recreated:
#
#     -e CAMSTACK_HUB_HEAP_MB=3072      # V8's real limit here: 3264MB
#
# 3264MB is 15% above the all-time measured max (2847MB, 2026-08-08) and 33%
# above today's, while the configuration that OOM'd four times in 15h (1536 →
# a real 1728MB) is 47% smaller than it. `--max-semi-space-size` is deliberately
# NOT plumbed here: the runners' young-generation cap won a measured ~15MB each
# and hub-main is ONE process, so the whole prize is ~25MB against a 3.7GB RSS —
# paid for with more frequent scavenges on the one thread that must not stall
# (D181). Not worth an image rebuild.
#
# This is no longer an IMAGE-level knob: the ceiling comes from the closure's
# launch-args module (a per-node override set from the hub, then the legacy
# CAMSTACK_HUB_HEAP_MB), so changing it needs a closure update and a restart,
# not a new image or a recreated container. The node says which case it is in
# on every boot: `[mem] hub-main heap ceiling …MB, set by <override|legacy-env|
# computed>`, or `… is V8's DEFAULT (…MB)` when no `--max-old-space-size`
# reached argv.
#
# Set on argv, NOT via NODE_OPTIONS — that would be inherited by every forked
# addon-runner child, which are sized separately in process-service.ts.
#
# The native allocator pair (MALLOC_ARENA_MAX=2 + VIPS_CONCURRENCY=1) is decided
# by the same module, for the same reason, and is welded: glibc reads
# MALLOC_ARENA_MAX once at malloc init, so hub-main cannot set it for itself —
# it must exist before `exec node`. Every forked runner then inherits it, and
# `applyRunnerNativeAllocator` still lets `CAMSTACK_RUNNER_NATIVE_ALLOCATOR=off`
# remove it per child. sharp reads MALLOC_ARENA_MAX in its NATIVE binding and,
# the moment it appears, restores libvips concurrency from 1 to
# `availableParallelism()` — 20 on the live host — so the pair travels together
# or not at all. An operator value already in the environment wins.
#
# FAIL OPEN: a missing module, a non-zero exit, a timeout or garbage output means
# NO extra args and no allocator env, and says so in ONE log line. The module is
# looked up in the active closure first, then in the baked seed (always present
# in this image), so the only way to lose the allocator pair is a module that
# crashes.
launch_candidates="${CAMSTACK_DATA:-/data}/server-root/current/node_modules/@camstack/server/dist/launch-args.js /opt/camstack-hub/node_modules/@camstack/server/dist/launch-args.js"
# [launch-args-begin]
launch_role="${CAMSTACK_ROLE:-hub}"
launch_js=""
for f in $launch_candidates; do
  if [ -f "$f" ]; then launch_js="$f"; break; fi
done
launch_records=""
launch_ok=""
launch_source=""
launch_extra=""
if [ -z "$launch_js" ]; then
  echo "[entrypoint] launch-args module not found — launching node with no extra args"
else
  launch_records="$(timeout 10 gosu camstack:camstack node "$launch_js" --role "$launch_role" --allocator-env 2>/dev/null)" || launch_records=""
fi
while IFS= read -r line; do
  case "$line" in
    "arg --"*)
      val="${line#arg }"
      case "$val" in *[!A-Za-z0-9=._-]*) continue ;; esac
      launch_extra="$val
$launch_extra"
      ;;
    "env "[A-Z]*=*)
      kv="${line#env }"
      name="${kv%%=*}"
      val="${kv#*=}"
      case "$name" in *[!A-Z0-9_]*) continue ;; esac
      # The loader and the shell are never the closure's to set.
      case "$name" in LD_*|DYLD_*|NODE_*|PATH|HOME|SHELL|IFS|USER) continue ;; esac
      case "$val" in *[!A-Za-z0-9._-]*) continue ;; esac
      # CAMSTACK_HEAP_CEILING_SOURCE is a fact about THIS launch, not a default.
      if [ "$name" = "CAMSTACK_HEAP_CEILING_SOURCE" ] || [ -z "$(printenv "$name")" ]; then
        export "$name=$val"
      fi
      ;;
    "source "*) launch_ok=1; launch_source="${line#source }" ;;
    "warn "*) echo "[entrypoint] launch-args: ${line#warn }" ;;
  esac
done <<LAUNCH_EOF
$launch_records
LAUNCH_EOF
if [ -n "$launch_js" ] && [ -z "$launch_ok" ]; then
  echo "[entrypoint] launch-args printed no usable plan — launching node with no extra args"
  launch_extra=""
fi
# `launch_extra` was built newest-first, so prepending line by line restores order.
while IFS= read -r val; do
  if [ -n "$val" ]; then set -- "$val" "$@"; fi
done <<LAUNCH_EOF
$launch_extra
LAUNCH_EOF
if [ -n "$launch_ok" ]; then
  echo "[entrypoint] node launch: role=$launch_role ceiling-source=$launch_source"
fi
# [launch-args-end]

# Privileged package helper (D326). This script is still root; Node is not.
# The helper is reparented to tini on exec and dies with the container.
mkdir -p /run/camstack
chown root:camstack /run/camstack
chmod 750 /run/camstack
export CAMSTACK_PKGD_SOCKET=/run/camstack/pkgd.sock
node /usr/local/bin/camstack-pkgd.mjs &
i=0
while [ ! -S "$CAMSTACK_PKGD_SOCKET" ] && [ "$i" -lt 50 ]; do
  i=$((i + 1))
  sleep 0.1
done
if [ ! -S "$CAMSTACK_PKGD_SOCKET" ]; then
  echo "[entrypoint] camstack-pkgd did not bind $CAMSTACK_PKGD_SOCKET — distro package installs will refuse until the next recreate"
fi

exec gosu camstack:camstack node "$@"
EOF
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

WORKDIR /opt/camstack-hub
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
# Entry = the STARTER (tiny, dependency-free, immutable). It picks the active
# /data/server-root closure (with probation boot + auto-rollback) or falls
# back to this baked seed's launcher. Update apply = graceful exit → the
# container restart policy relaunches → the starter loads the new version.
CMD ["/opt/camstack-hub/node_modules/@camstack/server/dist/starter.js"]

# ── Final: AMD (Mesa VA / Vulkan; no Intel GPU repo, no Intel NPU) ────────────
# Build: docker build --target amd -t ghcr.io/camstack/camstack:amd-local .
FROM runtime-common AS amd
LABEL org.opencontainers.image.variant="amd"
RUN apt-get update && apt-get install -y --no-install-recommends \
      mesa-va-drivers mesa-vulkan-drivers libvulkan1 && \
    rm -rf /var/lib/apt/lists/* && \
    test -e /usr/lib/x86_64-linux-gnu/dri/radeonsi_drv_video.so && \
    sh /usr/local/bin/camstack-check-libva-abi.sh /usr/lib/x86_64-linux-gnu/dri/radeonsi_drv_video.so

# ── Final: Intel (default target — last stage) ───────────────────────────────
# Build: docker build --target intel …  (or omit --target)
FROM runtime-common AS intel
LABEL org.opencontainers.image.variant="intel"
ARG NPU_TAR=linux-npu-driver-v1.33.0.20260529-26625960453-ubuntu2404.tar.gz
ARG NPU_URL=https://github.com/intel/linux-npu-driver/releases/download/v1.33.0/${NPU_TAR}
# The iHD driver and the libva it is loaded by are ONE decision (D926): both
# from Intel's repo, both pinned. Intel's iHD 25.x exports only
# `__vaDriverInit_1_22`; Ubuntu noble's libva is 2.20 (VA-API 1.20) and the
# driver package does not depend on libva2, so apt kept Ubuntu's — vaInitialize
# failed on every node of intel-1.2.509 and every decode ran in software.
# libva-x11-2 / libva-wayland2 / vainfo move with libva2 (Intel's libva-* pin
# libva2 to their own version). Bump these four together; the ABI check below
# refuses a pair that does not load.
ARG LIBVA_VERSION=2.22.0.2-96~u24.04
ARG VAINFO_VERSION=2.22.0.2-1~u24.04
ARG IHD_VERSION=25.2.4-1146~24.04
RUN curl -fsSL https://repositories.intel.com/gpu/intel-graphics.key \
      | gpg --dearmor -o /usr/share/keyrings/intel-graphics.gpg && \
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/intel-graphics.gpg] https://repositories.intel.com/gpu/ubuntu noble unified" \
      > /etc/apt/sources.list.d/intel-gpu-noble.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends intel-opencl-icd libze-intel-gpu1 libze1 \
      "intel-media-va-driver-non-free=${IHD_VERSION}" \
      "libva2=${LIBVA_VERSION}" "libva-drm2=${LIBVA_VERSION}" \
      "libva-x11-2=${LIBVA_VERSION}" "libva-wayland2=${LIBVA_VERSION}" \
      "vainfo=${VAINFO_VERSION}" \
      libmfx-gen1.2 libvpl2 && \
    sh /usr/local/bin/camstack-check-libva-abi.sh /usr/lib/x86_64-linux-gnu/dri/iHD_drv_video.so && \
    mkdir -p /tmp/npu-driver && cd /tmp/npu-driver && \
    curl -fsSL -o "${NPU_TAR}" "${NPU_URL}" && tar -xf "${NPU_TAR}" && \
    (dpkg -i ./*.deb || apt-get install -f -y) && \
    cd / && rm -rf /tmp/npu-driver && rm -rf /var/lib/apt/lists/*
# Intel VAAPI media driver (iHD). Without this pin, some hosts fall through to
# a missing backend and software-decode (~60% CPU for a few 4K HEVC cameras).
# /dev/dri is passed via --device. Do NOT set this on the amd stage.
ENV LIBVA_DRIVER_NAME=iHD
