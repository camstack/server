---
id: D588
title: An H.265 camera records to HKSV by re-encoding, and only where the operator allowed it
status: accepted
date: 2026-09-21
supersedes:
applies-to:
  - packages/addon-export-hap/src/hksv/recording-source.ts
  - packages/addon-export-hap/src/hksv/recording-invocation.ts
---

## Context

HKSV takes H.264 only, so the recording branch refused any camera whose every
enabled profile was H.265 (`no-h264-stream`, D84). That refusal was priced: a
permanent per-camera fMP4 child costs **0.7-2.8 % of one core** on `-c:v copy`
and **89.9 %** on a 4K→1080p software transcode, and the child runs whether or
not anything is watching.

What was never measured was the size of the population it refused. Swept on
2026-09-21: **14 of this fleet's 32 cameras publish H.265 on every enabled
slot.** The refusal was not a corner case, it was 44 % of the cameras, and for
them the alternative to a transcode is not a cheaper recording — it is no
recording at all.

Two other roads were checked first and are recorded so nobody re-walks them.
**Changing the camera's codec** is free and instant, and the operator ruled it
out. **HKSV3** (iOS 27, September 2026) records HEVC natively, by copy: Apple's
*Open Source Compatibility Guide* requires HEVC, `hap-nodejs` 2.1.7 still pins
`VideoCodecType.H264`, and the support exists only as an unmerged draft
([PR #1132](https://github.com/homebridge/HAP-NodeJS/pull/1132)). That is the
right destination — we already ship the live half in `src/multi-tier/` — but it
is not reachable today, and the operator chose to stay on what we have.

## Decision

`pickRecordingSource` takes `{ allowTranscode }` and, when no copyable slot
exists and the operator allowed it, picks an H.265 slot and marks the source
`transcode: true`. **A copy always wins when one exists** — an H.264 low beside
an H.265 high is never a reason to burn a core — and the option defaults to
absent-means-no at the picker, so forgetting the parameter refuses a camera
rather than quietly starting an encoder on it. The switch is the same
`allowTranscode` the live path already obeys, per camera.

The branch is named everywhere it costs something: on the source
(`RecordingSource.transcode`), in the fingerprint (`rec:<slot>+x`, so flipping
the switch rebuilds the accessory), and in both log lines that announce a
prebuffer.

`recordingOutput` decides what the fragments carry — the source size on a copy,
fitted to 1080p when the encoder is resizing — and the accessory advertises
**that**, never the input. On the encode branch we also own the key-frame grid
(`forceKeyFramesSeconds` = the fragment length), so a camera whose GOP is longer
than any fragment length we advertise is no longer withheld: that gate exists
only because a copy cannot cut where the source did not.

## Consequences

Turning HKSV recording on for an H.265 camera now starts a permanent encoder on
this hub. That is deliberate and it is opt-in twice over — the camera's own
recording switch, and `allowTranscode` — but `allowTranscode` ships ON, so the
second opt-in is a *non-refusal* rather than a choice. Anyone enabling
recording across the H.265 half of this fleet would be starting fourteen
permanent encoders; the log line says `branch: transcode` with the resolved
decoder so the cost is visible the moment it starts, and a software fallback is
a WARN.

Decode is the expensive half (77 % of a core for 4K→1080p on the live path,
decode-dominated), so the branch reads the decoder addon's own probe — the same
authority the live transcode and `AgentLoadService` use. The ENCODER stays
`libx264`: two of the four causes of the year-long HomeKit failure were an
absent `-g` and absent in-band parameter sets, both load-bearing on the encoder
(see `stream-hwaccel.ts`).

The picker applies the 1080p ceiling to the transcode branch too, for a second
reason: decode cost scales with the SOURCE, so reaching past a small slot would
be paid twice.

## Measured, once the branch finally ran

587's prebuffer started for the first time on 2026-09-21, and the cost is a
fraction of what the software figure predicted. Sampled from `/proc/<pid>/stat`
over 20 s, both children alive on the same hub at the same moment:

| camera | branch | CPU (1 core = 100 %) | RSS |
| --- | --- | --- | --- |
| 587 | transcode, `-hwaccel vaapi` + `libx264`, 1280×720 @10 fps | **11.6 %** | 376 MB |
| 101 | copy, 1280×720 | **0.1 %** | 51 MB |

Two things did the work: the decode landed on the GPU (the expensive half, per
`stream-hwaccel.ts`), and the picked slot is a 720p 10 fps mid rather than a 4K
main — the ceiling in `pickRecordingSource` is doing exactly what it was given
a second reason for. The 89.9 % in D84 remains true of what it measured, a 4K
→1080p **software** transcode, and is not the figure for this branch.

So the branch is ~100x a copy and about one eighth of a core. All fourteen
H.265 cameras recording at once would be ~1.6 cores — a real cost to decide
about, not a prohibitive one. Nothing here changes the rule: it stays opt-in,
and a software fallback is still a WARN, because without the GPU this number
goes back to the one D84 measured.

## Enforcement

`hksv/__tests__/recording-source.spec.ts` (copy-wins, opt-in default, ceiling)
and `hksv/__tests__/recording-invocation.spec.ts` (encode plan asserted on the
ARGUMENTS, per D578's lesson). Removing the pool rule or the key-frame grid was
confirmed to turn 5 tests red. `mappers/__tests__/hksv-build-outcome.spec.ts`
pins both verdicts for an H.265 camera: advertised with the switch on, withheld
with it off.
