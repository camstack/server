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
from one Dockerfile (`--target intel` / `--target amd`): `intel-<version>`,
`intel-latest`, `amd-<version>`, `amd-latest`. Unraid templates track
`intel-latest`; Proxmox / AMD APU hosts use `amd-latest`.

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

- **The bind paths are relative** (`./camstack-data`, `./camstack-config`,
  `./camstack-backups`, `./camstack-recordings`). Point the recordings bind at a
  disk with room; it is the one that grows. `/backups` is a declared `VOLUME`
  like `/data` and `/config`, so leaving it unmapped mints an anonymous volume.
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

## The hub's address

There is no variable for it. The hub's address is what the `local-network`
capability advertises — its interfaces, the port it really listens on, the
operator's allowlist, the tunnel and the mesh — plus the custom addresses the
operator adds, and the admin **Network** page's **Addresses** table is where
the operator sees them and ticks what each is used for
([D729](../decisions/adr-0729-the-hubs-address-comes-from-the-network-capability-never-from-an-environment-variable.md),
[D732](../decisions/adr-0732-a-hub-address-is-a-row-with-role-flags-and-custom-addresses-are-rows-like-detected-ones.md),
[D734](../decisions/adr-0734-address-roles-are-named-for-what-they-serve-and-notification-links-follow-the-public-endpoint.md)).
Every reader takes one role's answer from `local-network.getAddresses().roles`,
computed by that role's resolver in `packages/types/src/capabilities/hub-address.ts`:

| Reader | Role | Automatic (no address ticked) |
| --- | --- | --- |
| addon deploy and back-fill to an agent, model distribution (`server/backend/src/api/hub-cluster-url.ts`) | `internal` (**Internal**) | a LAN IPv4 literal, then any plausible LAN address, then the mesh — never the tunnel, never loopback |
| a Dreame robot camera's relay host, the Home Assistant media base | `internal` | the same |
| OIDC, WebAuthn defaults (`addon-auth`), OAuth2 account linking | `publicEndpoint` (**Public endpoint**) | the tunnel, then the mesh, then the LAN |
| the notification centre's action buttons, attachment / media links and admin links (`link-endpoints.ts`), the admin **Connect a phone** link | `publicEndpoint` | the same |
| where tapping a notification opens (the notification centre) | `notificationTaps` (**Notification taps**) | the CamStack app link |
| the apps' connection race (`getViewerEndpoints`) | `appConnections` (**App connections**) | every LAN IPv4 address, **over http and over https** (below), and the tunnel |

**Every LAN address advertised over `http://<ip>:4480` also has an `https://<ip>:4443`
row** (the TLS port, `withLanHttpsCounterparts` in
`packages/system/src/builtins/local-network/address-book.ts`), straight after it,
ticked for App connections by default and toggled on the Network page like any
other row ([D859](../decisions/adr-0859-every-lan-address-the-hub-advertises-over-http-also-has-an-https-counterpart-on-by-default-in-the-same-palette.md)).
Only the app-connection palette and the table carry it; `internal` and
`publicEndpoint` resolve over the palette without it. A phone that trusts the
hub's local CA reaches it, and when both addresses of a host answer the viewer
prefers https; a phone that does not fails that candidate in the race it already
runs (logged once per session as `tls-untrusted` or `unreachable`) and keeps
using the http row or the tunnel. Plain http on the LAN carries the session
token in clear, so a phone that should be protected at home needs the CA
installed. An Android app additionally ignores user-installed CAs until its
network security config allows them (open follow-up, D859).

When the detected address is not the one the other side dials — Docker bridge
networking (the hub only sees 172.17.x), NAT, a VPN, a reverse proxy — add it
as a **custom address** and tick the role on it. A custom address is
validated (http/https, no path, never loopback), serves only the roles ticked
on it and never wins a role automatically. `notificationTaps`, `publicEndpoint`
and `internal` are carried by one address each; ticking another moves it. A
plain `http://` address takes Public endpoint only after the operator accepts
http, and the CamStack app link can only be the notification-taps address.
Changing the public endpoint changes the passkey relying party, so passkeys
registered under the old one stop working.

`CAMSTACK_HUB_PUBLIC_URL` and its older alias `CAMSTACK_PUBLIC_ORIGIN` are
retired. A container that still sets one logs a WARN in the `public-url` scope
on every boot ("ignored — the hub address comes from Network"), and the hub
removes it from its environment before any addon runner is forked
(`server/backend/src/boot/retired-public-url-env.ts`). The guard
`scripts/check-no-hub-address-env.ts` refuses any runtime code that names
either again. When the hub cannot name an address an agent can reach, an agent
delivery fails with that reason — it never hands out `127.0.0.1`, which names
the agent itself.

## Optional settings for TLS, port and origins

All optional, all `advanced` in the Unraid template:

| Variable | Default | What it does |
| --- | --- | --- |
| `CAMSTACK_TLS_ENABLED` | `true` | Any value other than `true` serves plain HTTP — for a reverse proxy that terminates TLS. |
| `CAMSTACK_PORT` | `4443` | The hub's HTTPS port. With bridge networking change the published mapping instead. |
| `CAMSTACK_CORS_ORIGINS` | blank | Extra browser origins, comma-separated (below). |

The image's healthcheck follows `CAMSTACK_PORT` and `CAMSTACK_TLS_ENABLED`, so a
hub moved off 4443 or onto plain HTTP does not report itself unhealthy.

There is no variable for the certificate itself. The hub issues its own from a
local CA ([D227](../decisions/adr-0227-the-hub-reissues-its-certificate-only-when-it-cannot-do-its-job.md));
to use your own, upload the PEM chain and key in **Network → Local access**,
which is also where you revert to the generated one and download the local CA
([D726](../decisions/adr-0726-a-nodes-certificate-is-set-only-in-the-admin-ui-and-what-the-ui-shows-is-what-the-listener-serves.md)).
`CAMSTACK_TLS_CERT` / `CAMSTACK_TLS_KEY` and the `tls.certPath` / `tls.keyPath`
keys of `config.yaml` are ignored; a node that still sets one logs a WARN at boot.

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
Expo web on `http://localhost:8081`, use one of these and then restart:

```yaml
# config.yaml
server:
  corsOrigins:
    - http://localhost:8081
```

or `CAMSTACK_CORS_ORIGINS=http://localhost:8081,https://viewer.example`.

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
