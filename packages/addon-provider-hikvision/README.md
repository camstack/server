# @camstack/addon-provider-hikvision

Hikvision ISAPI camera/NVR provider for CamStack. Speaks HTTP(S) ISAPI with HTTP Digest auth and hands RTSP URLs to the camstack stream-broker for video pull (no in-process video work).

## v0.1 surface

- **Connection**: ISAPI over HTTP or HTTPS, digest auth (RFC 7616, MD5+qop=auth). HTTPS uses `rejectUnauthorized: false` because Hikvision ships self-signed certs by default.
- **Probe**: `/ISAPI/System/deviceInfo` — used by the Add-Device modal's Test button + by `onCreateDevice` to confirm the camera responds and persist the model/serial cache.
- **Snapshot**: `/ISAPI/Streaming/channels/{id}/picture?snapShotImageType=JPEG` (registered as the `snapshot` native cap; the system snapshot wrapper handles caching + sleep gating on top).
- **Reboot**: `/ISAPI/System/reboot` (registered as the `reboot` native cap).
- **Stream discovery**: `/ISAPI/Streaming/channels` enumerates every (camera, slot) pair on single-camera devices and NVRs. Each enabled entry is published to the stream-broker as a `pull-rtsp` source (`rtsp://user:pass@host:554/Streaming/Channels/{id}?transportmode=unicast`).
- **Alarm stream**: subscribes to `/ISAPI/Event/notification/alertStream`; the multipart parser emits `EventCategory.Motion` (with hysteresis: motion → inactive after 3s of silence) and `EventCategory.NativeDetection` (smart events: line-cross, region-entrance/exit, field-detection — class names normalised via `HIKVISION_AI_CLASS_MAP`).

## v0.2 surface (added)

- **PTZ** — `ptz` cap registered when `/PTZCtrl/channels/{id}/capabilities` reports any of pan / tilt / zoom. Methods: `move` (one-shot 500ms burst then auto-stop), `continuousMove`, `stop`, `getPresets` (`/presets`), `goToPreset` (`/presets/{id}/goto`), `goHome` (alias for preset id `1`). Speed range -100..+100 per axis as Hikvision documents; clamped on send.
- **Supplemental light** — `switch` + `brightness` caps registered when `/Image/channels/{id}/supplementLight/capabilities` advertises any non-`close` mode. The "on" mode is picked deterministically: `colorVuWhiteLight` when present (newer ColorVu firmwares), else the first non-`close` mode. Brightness 0..100 — when the light is off, brightness writes are stashed and applied on the next `setState({on:true})`.
- **Siren / alarm output** — `switch` cap registered when `/System/IO/inputs` lists at least one alarm input port. Defaults to port `1` (the typical built-in-siren GPIO). Note: the camera-side **Linkage Method** (Configuration → Event → Linkage Method) must be configured to fire the siren tone / strobe when the input flips — the API only toggles the input state. v0.2 limitation: when both supplemental light and siren are present, the supplemental light owns the `switch` cap; the siren registration logs and skips. Child accessory devices (one per cap) land in v0.3 to fix the collision.

The probe runs once per camera lifetime (after the first successful `publishToBroker`); results are cached into `deviceCache.{hasPtz,hasSupplementalLight,hasAlarmIo}` so the next boot can short-circuit without re-probing. Cap registration itself is always re-done at runtime.

## Deferred to v0.3+

- **Child accessory devices** — model siren / supplemental light as separate child `IDevice` rows (parentDeviceId = camera) so the two switches don't have to share the parent's `switch` cap. Mirrors Reolink's `ReolinkAccessory` pattern.
- **Two-way audio (intercom)** — `/ISAPI/System/TwoWayAudio/...` plus RTP relay; out of scope until camstack adds an intercom cap that other providers can also implement.
- **AI thumbnail forwarding** — the alarm-stream parser sees `image/jpeg` parts that follow smart-detection events but discards them. Hook lands cleanly in `pumpAlarmStream` when consumers ask for it.
- **PTZ position read-back** — `/PTZCtrl/channels/{id}/status` is firmware-dependent; today we return a stub `{0,0,0}` for `getPosition`.

## Notes

- **Channel id encoding**: Hikvision uses `{cameraNumber}{streamSlot}` — `101` = camera 1 / main, `102` = camera 1 / sub, `201` = camera 2 / main. Single-camera devices yield `native:main` / `native:sub` cam-stream ids; multi-channel NVRs yield `ch{N}-main` / `ch{N}-sub`.
- **Old NVR fallback**: pre-2018 NVRs (DS-7600 series and similar) lack `/ISAPI/Streaming/channels`. The provider falls back to a synthetic `[101, 102]` channel set so video still publishes.
- **Motion debounce**: Hikvision fires VMD events every ~1s while motion is active. The driver flips the `motion` cap to `detected: true` on the first event of a burst and waits 3s of silence before flipping back to `detected: false` — emitting both the activated and deactivated transitions on the event bus.

## References

- ISAPI Service v2 & v3 specs (Hikvision ISAPI doc package — vendor download).

<!-- readme:generated:start (derived from the manifest; edit outside this block) -->

Package `@camstack/addon-provider-hikvision` on npm.

## What it provides

- **Hikvision** (`provider-hikvision`): Hikvision ISAPI camera/NVR provider — discovers RTSP streams, captures snapshots, parses the alarm event stream. Category: providers.
  - Capabilities: `device-provider`, `stream-params`, `recording-onboard`, `motion-zones`, `privacy-mask`, `day-night`, `image-settings`, `failure-contribution`, `videoclips`.

## Configuration

Edit these from System, Addons, this addon, Settings (a device's own settings are on its device page). A password field is stored in the keychain.

**Adding a device**

- Camera: Name
- Credentials: Username, Password
- Connection: Camera IP, Port, Use HTTPS

**Per-device settings**

- Supplemental Light: Mode (on), Default brightness, Mode, Brightness regulator, IR brightness, White-light brightness
- Siren / Alarm Output: Alarm input port, Auto-release after (ms)
- Connection: Camera IP, Port, Use HTTPS, RTSP transport, Username, Password
- On-camera motion (VMD): Motion detection, Sensitivity
- Image: Brightness, Contrast, Saturation, Sharpness, WDR, WDR level, Day/Night
- Time / NTP: Timezone, Time sync, NTP server, NTP port, Sync interval (min), Manual date & time, Sync time
- Two-way audio: Mode
- Two-way audio channel: Audio codec, Input source, Speaker volume, Noise reduction
- and 4 more sections

## Requirements

- Placement: hub-only.
- Runtime dependencies installed with the addon: `onvif`, `werift`.
- A CamStack hub. An agent is used only where the placement above allows it.

## Documentation

- [docs/addons/addon-provider-hikvision.md](https://github.com/camstack/server/blob/main/docs/addons/addon-provider-hikvision.md)
- [docs/architecture/device-model.md](https://github.com/camstack/server/blob/main/docs/architecture/device-model.md)
- [packages/addon-provider-hikvision/AGENTS.md](https://github.com/camstack/server/blob/main/packages/addon-provider-hikvision/AGENTS.md)

See [CHANGELOG.md](./CHANGELOG.md) for what changed in each version.

<!-- readme:generated:end -->
