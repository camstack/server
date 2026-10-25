# CamStack

CamStack is free software for cameras and the other devices in a house.
**0.1 is a beta.** It runs on hardware you control: live video, recordings,
detections and events stay there.

The licence is [MIT](LICENSE).

Guides: <https://camstack-docs.zentik.app>

Contributing: [CONTRIBUTING.md](CONTRIBUTING.md). Questions:
[Discussions](https://github.com/camstack/server/discussions).
Vulnerabilities: [SECURITY.md](SECURITY.md).

## What it does

**Cameras and live view.** WebRTC from the camera, including H.264 and H.265.
Two-way audio, pan/tilt/zoom, presets, lights, sirens, privacy masks and image
settings where the camera exposes them. Battery cameras are read from cached
state, so opening a page does not wake them.

**Recording and playback.** Continuous and event recording, with a timeline.
High-quality and low-quality copies can sit on different disks. Copies can also
go to S3-compatible storage, WebDAV, SFTP or SMB.

**Detection.** People, vehicles, animals, packages, faces, licence plates,
motion zones and audio events (a smoke alarm, glass breaking), on your
hardware. Face and plate galleries are yours. Accelerators: CPU, Intel GPU and
NPU, AMD GPU, Apple Neural Engine and VideoToolbox, NVIDIA CUDA and TensorRT,
Coral Edge TPU.

**Events.** A library you can search by camera, time, object, face, plate and
zone.

**Notifications.** Rules by camera, zone, object and schedule. A message that
fired is retried and kept in a history. Channels: ntfy, Pushover, Gotify,
Telegram, Discord, email, WhatsApp, a webhook, or Zentik. An optional vision
or language model can describe a crop, or check a rule before the message is
sent. If that model is down, the alert still goes out. Calendars and
waste-collection days can raise the same notifications.

**Home integrations.** Home Assistant (a component for Home Assistant, and
importing devices from a Home Assistant instance), Apple Home (HomeKit,
including Secure Video), Alexa, Google Home, Matter and MQTT. A device is
exported only when you pick it.

**Devices.** Cameras and streams: Reolink, Hikvision, Amcrest, UniFi, Wyze,
ONVIF, generic RTSP. Other devices: Tuya, Home Assistant, Alexa, Matter,
Homematic, Bosch (SHC, Home Connect, HomeCom), Velux, Dreame, Petkit, VeSync,
Gree, Dreo, Ecowitt, Rademacher, Unraid, and MQTT discovery.

**More than one machine.** One hub, plus agents on Linux, macOS and Windows.
Decoding and detection can run on the machine that has the accelerator. An
agent is paired from the hub with a six-digit code. There is no shared cluster
password.

**Models.** A model studio for the detectors you run, and training on your own
machine. Training on Modal runs only after you add a token.

**Apps.** The admin UI is the browser on the hub (port 4443). The viewer —
live view, events, recordings — is an iOS app, an Android app, the web viewer
served by the hub, and a desktop viewer for macOS and Linux. Linking a phone
uses <https://camstack.zentik.app>, which opens your hub. That site is not an
account, and it does not serve video.

**Backups and storage.** Recordings, low-quality recordings, event media and
backup archives are separate storage locations, on a local disk or on the
remote providers above.

**Access.** Local accounts, TOTP, passkeys, OpenID Connect, email sign-in
links and API keys. Remote access without opening a router port: Cloudflare
Tunnel or Tailscale, when you turn them on.

**Automations.** Visual recipes (when / only if / then) and scripts. Both are
admin-only. A web terminal is limited to profiles an admin has allowed.

## Cloud and downloads

CamStack does not require an account with us, and it does not upload footage.

Two pieces are hosted, because the other side requires it:

- **Alexa.** The smart-home skill uses an AWS Lambda. Amazon does not call a
  machine on your LAN. You deploy that function; the template ships in
  `packages/addon-export-alexa/lambda-template`.
- **<https://camstack.zentik.app>.** A public page that links the mobile apps
  and notification taps to your hub. The hub address is in the link.

These are downloads, not a service the hub calls while it runs:

- Packages from npm, and container images
  `ghcr.io/camstack/camstack:intel-<version>` and `:amd-<version>`
- Detection models from the public Hugging Face repository
  `camstack/camstack-models`, and trainer sources from `camstack/camstack-trainer`
- Optional language-model weights from public Hugging Face repositories, when
  you choose one
- Desktop updates from [GitHub Releases](https://github.com/camstack/server/releases)

Anything else that leaves the house is an integration you configured: a
notifier, an LLM endpoint (OpenAI, Anthropic, Google, or a URL you set),
Google, Alexa, HomeKit, Home Assistant, Cloudflare, Tailscale, remote storage,
or Modal.

## Install

This is a beta. Read the page for your route before the first camera.

| Route | |
| --- | --- |
| Docker | `ghcr.io/camstack/camstack:intel-<version>` or `:amd-<version>` (and `-latest`). `CAMSTACK_ROLE` is `hub` or `agent`. [Installation](https://camstack-docs.zentik.app/docs/installation), [Compose](https://camstack-docs.zentik.app/docs/installation/docker-compose) |
| Unraid | [Unraid](https://camstack-docs.zentik.app/docs/installation/unraid), [templates](https://github.com/camstack/unraid-templates) |
| Proxmox | [Proxmox](https://camstack-docs.zentik.app/docs/installation/proxmox), [install script](https://github.com/camstack/proxmox) |
| Desktop | macOS and Linux installers on [Releases](https://github.com/camstack/server/releases). [Mac](https://camstack-docs.zentik.app/docs/installation/mac). A Windows installer is not in the current releases. |

Open `https://<hub>:4443`. The first account is `admin` / `changeme`; the
first sign-in asks for a new password. The first-boot certificate is
self-signed.

A container that decodes video needs extra shared memory (`--shm-size=2g`).
Pass a GPU through when you have one:
[accelerators](https://camstack-docs.zentik.app/docs/installation/accelerators).

Streaming, recording and detection ship with the base install. Brand
integrations are addons you add from the admin UI.

## This repository

This tree is the server. Guides for installing and using CamStack are on the
docs site above. Contributors start at [CONTRIBUTING.md](CONTRIBUTING.md).
The map of this tree is [`docs/README.md`](docs/README.md).

To report a vulnerability, see [SECURITY.md](SECURITY.md). Questions go to
[Discussions](https://github.com/camstack/server/discussions).
