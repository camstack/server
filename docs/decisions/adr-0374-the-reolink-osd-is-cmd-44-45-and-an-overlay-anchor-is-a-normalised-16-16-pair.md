---
id: D374
title: The Reolink OSD is cmd_id 44/45, and an overlay anchor is a normalised 16.16 pair
status: accepted
date: 2026-09-06
supersedes:
applies-to:
  - packages/addon-provider-reolink/src/osd-mapping.ts
  - packages/addon-provider-reolink/src/osd-settings-section.ts
---

## Context

An operator reported that for device 3825 ("Camera stanza caldaia", a
battery camera on channel 3 of a Reolink Home Hub) the OSD flags in CamStack
"do not match the camera at all", and that the overlay position could not be
changed.

The first diagnosis was the obvious one and it was wrong. The OSD slice had
recently been given a freshness stamp and a serve-and-revalidate read (D224),
so staleness was the suspect. It was not: the raw-read debug surface (D346)
showed the snapshot was seconds old and still wrong. What it also showed is
that EVERY Reolink camera in the fleet reported the identical tuple —

    osdChannel { enable: 1, name: '', pos: '' }
    osdTime    { enable: 0, pos: '' }
    watermark  0

— which is not a reading, it is a fingerprint. The lib's `getOsd` is a
documented placeholder: it issues **cmd_id 26 (GetImage — the ISP block)** and
then text-greps that reply for `enable` / `name` / `pos` / `timeEnable` /
`watermark`. GetImage carries none of those tags, so the values were an
accidental first `<enable>` plus five defaults. The matching `setOsd` posts an
`<Osd>` body to cmd_id 25 (SetImage), which the firmware ignores — so the
writes had never landed either. Three of the four flags the form showed for
3825 were wrong, and none of them had ever come from an OSD command.

`getOsdDatetime` / `setOsdDatetime` (**cmd_id 44 / 45**) are the pair modern
firmwares answer: `<OsdDatetime>` (enable, topLeftX/Y, width, height,
language) and `<OsdChannelName>` (name, enable, topLeftX/Y, enWatermark,
enBgcolor). Note where the watermark lives — inside the channel-name block,
not at the top level.

That read also settled the position question the earlier work had explicitly
deferred ("zero values observed in 24 h of logs" — because the placeholder
always returned `''`). Read through cmd 44 the anchors are numbers, and the
vocabulary fell out of one camera whose placement the operator could describe:

| device | overlay | reported | operator says |
| --- | --- | --- | --- |
| 3825 | channel name | `(65536, 65536)` | bottom right |
| 3825 | timestamp | `(65536, 1)` | top right |
| 592 | channel name | `(1, 65536)` | — (bottom left) |
| 592 / 618 | timestamp | `(1, 1)` / `(0, 0)` | — (top left) |

Each axis is a normalised 16.16 coordinate: `0` (some firmwares echo `1`) is
the start edge, `65536` is the far edge.

## Decision

The Reolink OSD is read with `getOsdDatetime` (cmd_id 44) and written with
`setOsdDatetime` (cmd_id 45). `getOsd`/`setOsd` are never called again from
this driver.

An overlay anchor is a normalised 16.16 pair, decoded in exactly one place
(`osd-position.ts`) into three states: a **corner**, a **custom** placement,
or **unknown**. The position control offers the four corner pairs and nothing
else — those are the only values a camera in the fleet has been observed to
hold, and a value the camera might refuse is never offered. A camera holding
something else keeps it: the form shows a `custom` option carrying the raw
pair, and choosing it writes no coordinate.

The write is a patch that names ONLY the fields the operator touched. The lib
read-modify-writes the camera's own XML, so anything omitted survives verbatim
— building a full object here is what would silently overwrite a language, a
background-colour flag, or the anchor of the overlay that was not moved.

## Consequences

- `deviceCache.osdSnapshot` changes shape: the `channelPos` / `timePos`
  strings are gone (they only ever held the placeholder's `''`) and are
  replaced by `channelX/Y` and `timeX/Y` numbers. Zod strips the old keys on
  the next re-parse; the first read after the upgrade replaces the whole
  slice, so no migration is needed.
- The overlay position is now writable, which it was not before.
- The generic `osd` capability (`packages/types/src/capabilities/osd.cap.ts`,
  implemented today only by the Amcrest provider) is deliberately NOT also
  registered by Reolink. Two surfaces writing the same firmware state is the
  D62 failure mode; the driver's settings section stays the single knob.
- A snapshot pulled through CamStack does not show these overlays burned into
  the frame, so a change is verified against the camera's own read-back, not
  against a JPEG.

## Enforcement

`osd-settings-freshness.spec.ts` asserts structurally that `api.getOsd(` and
`api.setOsd(` do not appear in `reolink-camera.ts` and that the write goes
through `buildOsdDatetimePatch` + `setOsdDatetime`. `osd-position.spec.ts`
pins the vocabulary to the values captured from devices 3825 / 107 / 108, and
`osd-mapping.spec.ts` pins both the projection and the "only touched fields"
property of the patch against the raw replies those cameras returned.

## Update — 2026-09-06: the library was fixed at the source

The workaround above was written against a library that lied. That library is
ours (`@apocaliss92/nodelink-js`), so the lie has now been removed rather than
routed around: on `nodelink-js` `main`, `getOsd` delegates to cmd_id 44 and
`setOsd` to cmd_id 45, `OsdConfig` models the real `<OsdDatetime>` +
`<OsdChannelName>` overlays (watermark included, where the wire puts it —
`channelName.enWatermark`), a field the camera did not report is `null`
instead of a default, and the 16.16 corner codec ships as
`readOsdPosition` / `coordsForOsdCorner` / `OSD_CORNERS`. The docblock on
`setOsdDatetime` that claimed the anchors were *camera pixel coordinates* was
false and is corrected there too. A unit test fails if `getOsd` ever sends
cmd_id 26 again.

**This commit performs the migration.** It requires
`@apocaliss92/nodelink-js` **0.7.0** on the registry — publishing has been
failing on an expired `NPM_TOKEN` since 2026-08-25, so verify
`npm view @apocaliss92/nodelink-js version` before merging: with 0.6.x on the
registry the bumped dependency breaks `npm ci` repo-wide.

What it retires:

- `osd-position.ts` — deleted. It now imports `readOsdPosition`,
  `coordsForOsdCorner`, `isOsdCorner`, `OSD_CORNERS`, `OSD_CORNER_LABELS`,
  `formatOsdCoords`, `OSD_POSITION_MIN/MAX` from `@apocaliss92/nodelink-js`.
  `osd-position.spec.ts` keeps its fixtures and points at the lib — the
  vocabulary stays pinned to the same three cameras either way.
- `osd-mapping.ts` — stays (it is the form-keys ↔ camera boundary) but thins:
  `projectOsdSnapshot` takes the lib's `OsdConfig` from `api.getOsd(channel)`,
  and `buildOsdDatetimePatch` is now `buildOsdPatch`, naming corners instead
  of encoding coordinates. The 16.16 encoding is pinned by the library's own
  tests against these same cameras.
- `reolink-camera.ts` — `api.getOsd(channel, { timeoutMs: 4000 })` at the
  probe and `api.setOsd(this.getChannel(), patch)` at the save.
- The Enforcement guards invert: `osd-settings-freshness.spec.ts` asserted
  that `api.getOsd(` was ABSENT from `reolink-camera.ts`; it now asserts the
  opposite, plus that the driver never reaches past it to `getOsdDatetime` /
  `setOsdDatetime` — reaching past the library is how a second copy of the
  corner encoding would come back.
- `raw-read.ts` drops the `legacyPlaceholder` rider — it existed only to show
  an operator the fabricated tuple side by side with the real one, and there
  is no longer a fabricated tuple to show. The slice keeps `getOsdDatetime`
  because raw-read is the UNPROJECTED view: `getOsd` is the same command with
  the anchors already decoded into corners.
