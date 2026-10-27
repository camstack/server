# Reolink Provider

Reolink camera device provider addon for CamStack — native Baichuan protocol.

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-provider-reolink` on npm.

## What it provides

- **Reolink** (`provider-reolink`): Native Baichuan protocol connection to Reolink cameras — direct Annex-B push, no RTSP intermediary. Category: providers.
  - Capabilities: `device-provider`, `stream-params`, `recording-onboard`, `motion-zones`, `privacy-mask`, `log-channels`, `failure-contribution`, `stream-signals`, `videoclips`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Addon settings**

- Battery-cam Motion (Email/SMTP Push): Enable Email Push Server, Camera-facing host, SMTP Port, Virtual Domain
- Email Push Authentication: Require AUTH, Auth Username, Auth Password
- Battery-cam Motion (HaCfg Webhook): Enable HaCfg Webhook Server, Camera-facing host, HTTP Port, Bind host

**Adding a device**

- Camera: Name
- Credentials: Username, Password
- Connection: Connection mode, Host (IP / hostname / UID), Port, Device UID

**Per-device settings**

- Camera data: Refresh from camera
- Connection: Camera IP, Port, Username, Password
- Service ports: HTTP enabled, HTTP port, HTTPS enabled, HTTPS port, RTSP enabled, RTSP port, RTMP enabled, RTMP port, and 2 more
- Time / NTP: Timezone, NTP sync, NTP server, NTP port, Sync interval (min)
- On-camera motion (MdAlarm): Motion detection, Sensitivity
- Image: Brightness, Contrast, Saturation, Hue, Sharpness
- Advanced (ISP): Day/Night mode, Exposure
- IR + status LED: IR LED, IR brightness, Status LED, Doorbell LED
- and 12 more sections

## Requirements

- Placement: hub-only.
- Runtime dependencies installed with the addon: `@apocaliss92/nodelink-js`, `werift`.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/addons/addon-provider-reolink.md](https://github.com/camstack/server/blob/main/docs/addons/addon-provider-reolink.md)
- [docs/architecture/device-model.md](https://github.com/camstack/server/blob/main/docs/architecture/device-model.md)
- [docs/architecture/ui.md](https://github.com/camstack/server/blob/main/docs/architecture/ui.md)
- [packages/addon-provider-reolink/AGENTS.md](https://github.com/camstack/server/blob/main/packages/addon-provider-reolink/AGENTS.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
