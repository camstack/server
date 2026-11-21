---
title: Deploying
applies-to:
  - Dockerfile
last-verified: 2026-10-09
---

# Deploying

How to actually run this on a machine. Two routes — Docker Compose anywhere, or
the Unraid template — and one image behind both.

!!! note "The image is public; this repository is not"

    `ghcr.io/camstack/camstack` is a **public** package as of 2026-07-26 —
    an anonymous pull works, re-verified 2026-08-14 against the registry's own
    token endpoint: an anonymous token resolves both the tag list and the
    `intel-latest` manifest.
    `github.com/camstack/server` stays **private**, which is why the Unraid
    templates are distributed from a separate public repository
    ([camstack/unraid-templates](https://github.com/camstack/unraid-templates))
    rather than from here: a template's `<Icon>` and `<TemplateURL>` are fetched
    anonymously by Unraid, so pointing them into this repo returns 404 to
    everyone outside the org — and looks fine to anyone whose browser is already
    authenticated. The remaining one-time step is the Community Applications
    submission; see [unraid.md](unraid.md#one-time-operator-setup).

## One image, two roles

There is one image and it serves both roles. `CAMSTACK_ROLE` picks which at boot:
`hub` (the default) runs the full server and admin UI on 4443; `agent` runs a
worker that joins a hub and serves a status dashboard on 4444. A cluster is one
hub plus any number of agents, and an agent exists to put a second machine's
GPU, NPU or Coral to work.

There is no bare `:latest`. The release workflow publishes accel-prefixed tags
from one Dockerfile (`--target intel` / `amd` / `intel-legacy` / `nvidia` /
`nvidia-legacy`): `<accel>-<version>` and `<accel>-latest`. Unraid templates
track `intel-latest`; Proxmox / AMD APU hosts use `amd-latest`.

### Which tag for which GPU

| Your GPU | Tag | Notes |
| --- | --- | --- |
| Intel Gen12+ iGPU (Alder Lake, N-series, Core Ultra), Arc, Intel NPU | `intel-*` | current compute runtime (25.x) + NPU driver |
| Intel Gen8-Gen11 iGPU (UHD 6xx, Coffee Lake, Jasper Lake, Ice Lake) | `intel-legacy-*` | compute runtime 24.35 (`legacy1`, the last to support these); no NPU driver |
| AMD APU / GPU | `amd-*` | Mesa VA + Vulkan |
| NVIDIA Turing or newer (RTX 20/30/40/50, GTX 16; compute capability >= 7.5) | `nvidia-*` | CUDA 12.8 + cuDNN 9, `onnxruntime-gpu` 1.21-1.26 wheelhouse |
| NVIDIA Pascal / Maxwell (GTX 10 / 9; compute capability 5.0-6.1) | `nvidia-legacy-*` | CUDA 11.8 + cuDNN 8, `onnxruntime-gpu` 1.18.1 wheelhouse |
| None, or a GPU the image's runtime cannot enumerate | any, e.g. `amd-*` | the node reports `no-gpu-device` and the CPU serves |

Both NVIDIA images need the host's NVIDIA driver and the NVIDIA Container
Toolkit (`--gpus all`, or `--runtime=nvidia`): the toolkit injects `libcuda`
and `nvidia-smi`; the image carries only the CUDA runtime libraries and cuDNN.
Wheels are baked as a **wheelhouse** at `$CAMSTACK_ORT_WHEELHOUSE`
(`/opt/camstack/wheelhouse`), not installed: the pipeline's Python env is a venv
under `/data` that a system-level install would not reach. The build refuses a
wheel whose CUDA provider does not link the CUDA major the image ships.

!!! warning "State of the NVIDIA images"

    On a node with an NVIDIA card and the wheelhouse (`CAMSTACK_ORT_WHEELHOUSE`
    set), the pipeline installs `onnxruntime-gpu` from it instead of the CPU
    `onnxruntime` wheel (`requirements-onnxruntime-gpu.txt`), and `cuda` is
    offered only once the CUDA execution provider answers. Neither NVIDIA image
    has been run on a card yet. `nvidia-legacy` rests on third-party reports that
    CUDA 12 / cuDNN 9 `onnxruntime-gpu` builds need compute capability 7.0;
    CUDA 13 (`onnxruntime-gpu` 1.27+ default) dropped Maxwell/Pascal/Volta.
    Run the container with `--gpus all` and
    `NVIDIA_DRIVER_CAPABILITIES=compute,video,utility`.

## Docker Compose

The Compose example lives in the public docs (`camstack/docs`), not in this
repo. It carries both services: `camstack` starts by
default, `camstack-agent` sits behind the `agent` profile because a hub and an
agent on one host under host networking would collide on every port.

```bash
docker compose up -d                                  # the hub (seeds admin / changeme on first boot only)
docker compose --profile agent up -d                  # a worker, on another machine
```

Read the example before running it — it documents every setting inline, and three
things want your attention:

- **The bind paths are relative** (`./camstack-data`,
  `./camstack-backups`, `./camstack-recordings`). Point the recordings bind at a
  disk with room; it is the one that grows. `/backups` is a declared `VOLUME`
  like `/data`, so leaving it unmapped mints an anonymous volume.
- **Optional hardware ships commented out.** `/dev/dri` and `/dev/accel` are
  listed but disabled, because Docker refuses to start a container whose declared
  device is absent. Uncomment the `devices:` key *and* the entries this machine
  has — not the entries alone, which is a parse error by design (see
  [D23](../decisions/adr-0023.md) for what that design is protecting you from).
- **Host networking is the default.** An NVR pulls RTSP from LAN cameras and
  serves WebRTC, and both want the real host IP; under bridge networking WebRTC
  advertises a container address no client can reach. The header explains what to
  change if bridge is unavoidable.

The settings whose absence produces a failure that does not look like the setting
— `pids_limit`, `CAMSTACK_MEDIA_ROOT`, the Coral pairing, the restart policy —
are the same in both routes and are tabulated once, in
[unraid.md](unraid.md#what-must-be-true-and-why).

`--shm-size=2g` used to head that list, and it is gone since 2026-09-19: it
existed for the decoder frame rings, which left with `@camstack/shm-ring` on
2026-07-16, so for two months every deployment reserved a 2 GB tmpfs for a
subsystem that constructs nothing. `--pids-limit=8192` took its place, and it is
a real setting rather than a rounder default: a container cgroup counts
**threads**, and this hub was measured refusing 22 `clone()` calls in 45 minutes
against the 2048 default — each one a thread some subsystem needed and silently
did without, surfacing only as media that stopped. The ceiling stays a ceiling
because a ceiling is what makes a thread leak visible.

## AMD (VAAPI / WebGPU)

The container must be given `/dev/dri` (the GPU render nodes) — the Proxmox
compose files pass it with `devices: - /dev/dri:/dev/dri`. The AMD image's
entrypoint then drops privileges from root to user `camstack` (via
`gosu`), and at that point it grants `camstack` access to `/dev/dri/renderD*` and
`card*` nodes — granting the **initial root process** alone via Docker's
`group_add` does **not** apply to the dropped user, so `camstack` would get
`EACCES` on those render nodes. The entrypoint is where the permission grant
really happens.

**To enable GPU detection:** pass `/dev/dri` to the container (see above) and run
an AMD image that carries the D845 entrypoint fix; keeping `group_add` for the
render/video GIDs is harmless.

**How to verify the GPU is working:**

1. The pipeline log has no `WebGpuDeviceUnavailable` error.
2. On the host or inside the container:

```bash
cat /sys/class/drm/card*/device/gpu_busy_percent
```

If the GPU is being used, the values are above 0. If they stay 0 or the file is
absent, the GPU is not available.

**What `WebGpuDeviceUnavailable` means:** The WebGPU pool refused to use the
render node (could not open it, uid/gid mismatch, insufficient permissions) and
logged the reason (uid, gid, groups). The refusal is intentional — the pool does
**not** silently fall back to a software path. This prevents silent performance
regressions where the GPU reports "available" while actually using CPU.

## Unraid

Unraid is the reference deployment and has its own page:
[unraid.md](unraid.md). It covers installing from the template, the Community
Applications distribution route, and the one fact that constrains every future
template edit — an installed container keeps a frozen copy of its template and
never picks up an upstream change.

## Where the deployment files live

The Unraid templates live in `camstack/unraid-templates` and the Compose example
in the public docs. Both are maintained by hand, and nothing in this repo checks
them ([D717](../decisions/adr-0717-the-unraid-templates-and-the-compose-example-are-maintained-outside-this-repo.md)).
A change to the container contract updates both in the same piece of work.

`TZ` sets the hub's default time zone (the site location's zone, notification
text times). An empty `TZ=` is ignored by the starter and the node falls back to
the system zone; a zone the runtime cannot resolve reads as `UTC`.

## The hub's address

There is no variable for it: the hub's address, the roles an address serves and
the retired `CAMSTACK_HUB_PUBLIC_URL` are documented in
[network](network.md#3-the-four-roles).

## Optional settings for TLS and port

All optional, all `advanced` in the Unraid template:

| Variable | Default | What it does |
| --- | --- | --- |
| `CAMSTACK_PORT` | `4443` | The hub's HTTPS port. With bridge networking change the published mapping instead. |
| `CAMSTACK_HOST` | `0.0.0.0` | The address the hub binds. |
| `CAMSTACK_DATA` | `camstack-data` (`/data` in the image) | The data directory. |

These three are the whole bootstrap config: there is no `config.yaml` ([D1018](../decisions/adr-1018-the-bootstrap-config-is-the-environment-there-is-no-config-yaml.md)). For one release, a leftover file whose port, host or data path differs is still applied, with a WARN naming the variable to set; delete the file once you have set it.

The image's healthcheck follows `CAMSTACK_PORT` and tries HTTPS, then plain HTTP,
so a hub moved off 4443 or onto plain HTTP does not report itself unhealthy.

Whether the hub serves HTTPS is not a variable: it is **Serve HTTPS** in
**Network → Local access** (on by default, and on at first boot). Turn it off only behind a
reverse proxy that terminates TLS. It applies after the hub restarts: the
setting is mirrored to `<dataDir>/tls/enabled`, which the boot reads because the
listener is built before the settings database opens. `CAMSTACK_TLS_ENABLED` is
ignored and named in the boot log.

There is no variable for the certificate itself. The hub issues its own from a
local CA ([D227](../decisions/adr-0227-the-hub-reissues-its-certificate-only-when-it-cannot-do-its-job.md));
to use your own, upload the PEM chain and key in **Network → Local access**,
which is also where you revert to the generated one and download the local CA
([D726](../decisions/adr-0726-a-nodes-certificate-is-set-only-in-the-admin-ui-and-what-the-ui-shows-is-what-the-listener-serves.md)).
`CAMSTACK_TLS_CERT` / `CAMSTACK_TLS_KEY` are ignored; a node that still sets one
logs a WARN at boot.

The generated CA is name-constrained: critical `nameConstraints` limit it to the
private address ranges and local-only names, so a device that trusts it does not
trust it for the rest of the internet; a name outside them (a public hostname, a
global IPv6) is simply not in the generated leaf. An uploaded certificate that does
not chain to a public CA must be uploaded together with its CA, which **Download CA**
then serves. **Revert to generated** keeps the upload (and its CA) stored so it can be
selected again ([D873](../decisions/adr-0873-the-generated-local-ca-is-name-constrained-and-an-upload-not-signed-by-a-public-ca-must-bring-its-ca.md)).
A hub whose stored CA predates the constraint replaces it once at the next boot; the
Local access page then asks you to download and trust the CA again.

A CA created from 2026-10-21 on is named after the hub — subject
`CamStack Local CA — <name>`, cut to the 64 characters a CN may hold — so the CAs of
two hubs installed on one phone can be told apart in its settings. A CA created at
boot takes the hub's hostname (the stored server name is not readable that early;
a container id or `localhost` gives the plain `CamStack Local CA`); one created by
**Regenerate** or **Revert to generated** on the hub takes the server name. An existing CA is never
reissued to rename it: every device that trusts it would have to install it again.
The leaf keeps the CN `camstack.local`, which is also one of its SANs.

## Browser origins that may call the hub

A web page on a different origin can read hub responses, or open the `/trpc`
socket, only when its origin is on an allowlist
([D707](../decisions/adr-0707-a-browser-origin-reads-the-hub-only-from-an-allowlist-and-never-with-the-session-cookie.md)).
Some origins are allowed already: the hub's own (whatever address the browser
used — the request's `Host`), the hosted viewer at
`https://camstack.zentik.app` and the native app's embed (`null`). To add another, for example a self-hosted viewer or
Expo web on `http://localhost:8081`, add it under Identity → Authentication →
Sign-in policy → Allowed browser origins. It applies to the next request, with
no restart. There is no environment variable for it:
the retired `server.corsOrigins` and `CAMSTACK_CORS_ORIGINS` are ignored
(silently: the boot no longer names them).

The hub logs a refused origin once, in the `cors` scope, with this hint.
Cross-origin callers authenticate with a bearer token. The session cookie
never crosses origins.

## What a deployment does *not* update

The container image is close to a boot loader, and confusing it with the
application costs hours. [update-and-release.md](update-and-release.md) has the
full picture; the part that matters when deploying:

| Layer | Reaches a node via | You need a new image? |
| --- | --- | --- |
| Framework (`types`, `system`, `sdk`, …) | the `@camstack/server` closure an update installs | no |
| Addons | `camstack deploy`, or the Admin UI | no |
| Node runtime, GPU/NPU drivers, entrypoint | the image itself | yes |
| ffmpeg | a per-node download, pinned by a framework constant | no |

So a hub keeps updating itself after install, an agent's application version is
managed by its hub, and the image tag you deployed says little about the code
that is running. Pull a new image for what is baked into it.

**ffmpeg moved out of that list on 2026-09-19** ([D540](../decisions/adr-0540-every-node-downloads-the-same-pinned-ffmpeg.md)).
The image installs no ffmpeg at all: every node downloads the same pinned
jellyfin-ffmpeg build, stated once in `packages/types/src/deps/ffmpeg-artifacts.ts`,
SHA-256 verified before extraction. The version became data instead of code —
changing it is a framework bump, not an image rebuild and a container swap on
every machine — and because we ship no binary we convey no GPL work. What an
image cannot delegate is the **drivers**, and those stay: libva plus the iHD
media driver. Measured the same day, the portable build encodes VAAPI inside the
container and *aborts* on the bare Unraid host, where `libva-drm.so.2` does not
exist. See [ffmpeg.md](ffmpeg.md).

One thing the image no longer carries is the addon tree
([D129](../decisions/adr-0129.md), 2026-08-13): every non-system addon is
installed from npm during the first boot, at `latest`. A machine with no registry
access still boots and says so, but comes up with **no addons** — a fresh `/data`
is deliberately no longer functional offline.

**Every release now builds an image.** GHCR carries a near-continuous
`intel-1.2.87` … `intel-1.2.109` run as of 2026-08-14, one per `v*` tag, and
`intel-latest` follows the newest build that finished. The gap worth knowing is
the opposite one: a release whose Electron leg failed stays a **draft** on the
releases page while its image is already on GHCR and `intel-latest` has already
moved (`v1.2.104` and `v1.2.105` are both in that state). The registry, not the
releases page, answers "does an image for this version exist" — see
[update-and-release.md](update-and-release.md#cutting-a-release).
