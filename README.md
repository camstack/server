# CamStack

Self-hosted camera and smart-home platform. Cameras, sensors and devices from
different brands become one system: one interface, one set of automations, and
recordings that stay on your own hardware.

Everything runs on machines you control. No vendor cloud, no per-camera
subscription, no footage leaving the house unless you send it somewhere.

## What it does

**Cameras**

- Live view with sub-second latency, straight from the camera to the browser.
  H.264 and H.265 without re-encoding, so a wall of cameras does not cook the CPU.
- Continuous and event-triggered recording, with a scrubbable timeline.
- Two-way audio on cameras that support it — talk through a doorbell from the
  browser.
- Pan / tilt / zoom, presets, autotracking, floodlights, sirens, privacy masks,
  day-night and image settings, on-screen display — whatever the camera exposes.
- Battery cameras are treated as battery cameras: the interface reads cached
  state instead of waking them up every time you open a page.

**Seeing what happened**

- On-device detection of people, vehicles, animals, faces and licence plates.
  Models run locally, on the CPU, an Intel iGPU or NPU, or Apple's Neural Engine.
- Face and plate recognition against your own gallery — no third-party service.
- Motion and audio analysis, so a smoke alarm or breaking glass can raise an alert
  as well as a moving shape.
- Events are labelled by what was actually detected, so you browse them by object,
  camera and zone rather than scrolling a timestamp list. A Detection Intelligence
  view groups repeat appearances of the same face or vehicle together.

**Alerts, and an alarm**

- Notification rules you can actually express: this camera, this zone, this kind of
  object, at these hours. Delivery goes through a durable outbox, so a rule that
  fired is recorded, retried and browsable in History rather than fired and
  forgotten.
- Per-camera mutes, per-rule snoozes, and a simulator that injects a synthetic
  event and tells you what every rule did with it — matched or not, which
  condition failed first, and what it would have sent.
- An optional second opinion before a notification leaves: a vision model looks at
  the exact crop about to be sent and votes on whether it agrees with the rule. It
  fails open, so a model that is down never costs you an alert.
- A built-in alarm panel — arm modes with exit and entry delays, a bounded
  triggered state that re-arms itself, and a guard that refuses to arm on an open
  contact unless you bypass it.
- Scheduled timelapses and multi-camera digests, rendered on the hub and delivered
  like any other notification. What they produce is kept on a bounded shelf that
  expires on its own instead of growing forever.

**Beyond cameras**

Lights, blinds, climate, plugs, vacuums, weather stations, pet feeders and more,
through per-brand integrations. Devices from different ecosystems sit side by side
and can trigger each other.

**Making it do things**

- Automations are authored visually — WHEN, AND ONLY IF, THEN — over the fields
  and events your devices actually expose, with triggers on device state, device
  events, a schedule, or a button. The recipe compiles to TypeScript, and you can
  eject to that code when the visual form runs out.
- Scripts, for when you want to start there instead. Both run in a supervised
  process of their own, and both are admin-only: this is running your code on your
  server.
- A web terminal, restricted to profiles an admin has allowed — a client asks for
  a profile, never for a command line. Those same profiles can be published as
  cameras, so a system monitor sits in a grid next to the driveway.

**Who gets in**

Local accounts with TOTP two-factor, passkeys (WebAuthn), single sign-on over
OIDC, passwordless email links, and API keys for scripts. Sessions and linked
integrations are listed and revocable.

**Fits what you already run**

- **Home Assistant**, through a native component —
  [`camstack/homeassistant-component`](https://github.com/camstack/homeassistant-component),
  installable from HACS. CamStack pushes; Home Assistant never polls it. Cameras
  arrive as real `camera` entities with WebRTC live video, and the rest as covers,
  climate, locks, vacuums and the other native platforms rather than as a wall of
  sensors. No MQTT broker and no YAML. It goes the other way too: a Home Assistant
  instance can be added as an integration and its devices imported into CamStack.
- **Apple Home**, through a real HAP accessory server. Cameras stream, and support
  HomeKit Secure Video recording; other devices are published from their
  capabilities, so what a device offers is what appears.
- **Alexa**, through a Smart Home skill. Devices you expose are discovered,
  controllable by voice, and report their state back as it changes. This one needs
  a small AWS Lambda you deploy yourself — Alexa will not call a machine on your
  LAN directly. Alexa's own connected devices can be imported into CamStack as
  well.
- MQTT and Matter for everything else.
- Notifications by push, email, or your own webhook.
- Remote access without opening a port on your router, via a Cloudflare tunnel or
  Tailscale.
- Recordings and backups can be sent to S3-compatible object storage, WebDAV or
  SFTP, as well as local disk.

Devices are not exposed to any of these by default. You pick them per device, in
the interface, and each export keeps its own list.

**Grows with you**

Start on one machine. Add a second and it joins as a worker — decoding and
detection spread across both, and you manage them from the same interface. A mini
PC with an Intel iGPU makes a very good detection node.

## Install

### Docker

One image; the role is chosen by an environment variable.

```bash
docker run -d --name camstack \
  -p 4443:4443 \
  --shm-size=2g \
  -v camstack-data:/data \
  ghcr.io/camstack/camstack:intel-latest
```

`--shm-size=2g` is not optional on any node that decodes video. Docker's 64 MB
default `/dev/shm` is too small for the decoder frame rings, and running out of it
surfaces as an uncatchable crash inside the decoder rather than as an error message.

Open <https://localhost:4443> and log in with `admin` / `changeme` — the first
sign-in asks you for a new password. The certificate is self-signed on first boot, so expect a browser
warning.

To add a second machine as a worker:

```bash
docker run -d --name camstack-agent \
  --network host \
  --shm-size=2g \
  -e CAMSTACK_ROLE=agent \
  -v agent-data:/data \
  ghcr.io/camstack/camstack:intel-latest
```

A worker joins by being **paired** from the hub: it advertises itself on the
network, you pick it on the hub (System → Cluster → Agents) and confirm the same
six digits on the hub and on the worker's page (port 4444). The hub then signs the
worker a certificate — there is no cluster secret to copy, and no secret goes in an
environment variable.

For Compose and Unraid — where the ports, devices and volumes are already filled
in — see the Docker Compose example in the public docs
(https://camstack-docs.zentik.app) and the Unraid templates in
[`camstack/unraid-templates`](https://github.com/camstack/unraid-templates).

### Desktop app

A single app per OS; you pick hub or worker on first run. Installers on
[GitHub Releases](https://github.com/camstack/server/releases).

| OS | Installer |
|---|---|
| macOS | `CamStack-X.Y.Z-{arm64,x64}.dmg` |
| Linux x64 | `CamStack-X.Y.Z-x86_64.AppImage` or `CamStack-X.Y.Z-amd64.deb` |

The app updates itself from those same releases.

On an Apple Silicon Mac, prefer the desktop app over Docker: it gets
VideoToolbox and the Neural Engine, which Docker cannot pass through.

### Adding cameras

The base install ships streaming, recording and detection. **Brand integrations
are installed on demand** — open Addons in the interface and add the ones you
need. That keeps the download small and avoids shipping driver code for hardware
you do not own.

Reolink, Hikvision, Amcrest, UniFi, Wyze, ONVIF and generic RTSP are supported for
cameras, alongside integrations for Tuya, Home Assistant, Alexa, Matter, HomeMatic,
Velux, Dreame, Petkit, VeSync, Gree, Dreo, Ecowitt, Rademacher and Unraid. The full
list, always current, is in [`docs/reference/addons.md`](docs/reference/addons.md);
what any of them can actually be asked to do is in
[`docs/reference/capabilities.md`](docs/reference/capabilities.md). Both are
generated from the code on every commit, so neither can quietly go out of date.

## Hardware acceleration

Decoding video in software is what makes a camera server slow. Passing a GPU in is
usually the difference between four cameras and forty.

**Intel iGPU (Quick Sync) or NPU** — add to the `docker run`:

```bash
  --device /dev/dri:/dev/dri \
  --group-add video \
  --group-add render \
  --device /dev/accel:/dev/accel     # Intel NPU, Core Ultra and newer
```

The active acceleration is shown under **Settings → System Info → Hardware**.

**Unraid:** the user the container runs as must be in the `video` and `render`
groups. The same iGPU passthrough guides written for Plex and Jellyfin apply
unchanged.

**Apple Silicon:** use the desktop app.

## Configuration

Most settings live in the interface. A few are read at boot from environment
variables or from `<data-dir>/config.yaml`.

| Variable | Default | What it does |
|---|---|---|
| `CAMSTACK_DATA` | `./camstack-data` | Where everything is stored — database, recordings, snapshots, logs, models |
| `CONFIG_PATH` | `<data>/config.yaml` | Config file location |
| `CAMSTACK_ROLE` | `hub` | `agent` boots this machine as a worker instead |
| `CAMSTACK_HUB_ADDRESS` | _auto-discover_ | Explicit hub address for a worker (`ws://hub.lan:4443/agent`) |
| `CAMSTACK_AGENT_NAME` | hostname | Display name for this machine |
| `CAMSTACK_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `CAMSTACK_STATUS_PORT` | `4444` | A worker's own local dashboard |

`config.yaml` covers the port, bind address and the keychain's master-key
location — never a secret value. A fresh hub seeds the `admin` / `changeme`
account. The full schema, including everything not listed above, is
[`packages/system/src/kernel/config-schema.ts`](packages/system/src/kernel/config-schema.ts).

Behind a reverse proxy, terminate TLS upstream and let CamStack listen plain on the
proxy network.

## Where things are

| | |
|---|---|
| **User guides** | <https://github.com/camstack/docs> |
| **How it is built** | [`docs/README.md`](docs/README.md) — architecture, decisions, history |
| **Contributing** | [`CLAUDE.md`](CLAUDE.md) — conventions and the rules that matter |

The technical documentation is partly generated from the repository itself, so it
cannot drift from the code. That is deliberate; the reasoning is in
[`docs/decisions/adr-0019.md`](docs/decisions/adr-0019.md).

## Development

```bash
npm install
npm run dev:full        # everything, in watch mode
npm run dev:server      # just the server
npm run dev:admin       # just the interface
npm run dev:cluster     # a hub plus one worker
```

Then `npm run build`, `npm run typecheck`, `npm run test`. Start with
[`docs/architecture/overview.md`](docs/architecture/overview.md).

## License

MIT.
