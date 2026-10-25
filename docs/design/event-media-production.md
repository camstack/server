# Event media production — where a clip comes from, and how the ring finally goes away

<!-- last-verified: 2026-08-08 -->

Companion to [D91](../decisions/adr-0091.md). That record states the rule; this
page holds the numbers behind it, the cost of the ring that remains, and the two
roads to deleting the second path entirely.

## The shape today

```
event ──► NC outbox drain ──► streamBroker.produceEventMedia   (ONE window)
                                    │
                                    ├─ mux mp4 from the retained AnnexB ring   (-c:v copy when nothing changes)
                                    ├─ derive gif FROM THAT MP4                (palettegen + paletteuse)
                                    └─ store artifacts, return handles + coverage{fromTs,toTs}
                                            │
                              fetchEventMedia(handle) pinned to artifact.nodeId
                                            │
                                    gif + mp4 attached to ONE notification
```

Fallback, when the hub predates the method or the production refuses: two
`renderPreBufferClip` calls with **identical** parameters (same instant, same
rolls, same profile). Coherent by discipline rather than by construction, and
the log line says which path served (`one production, every attachment` versus
`served by the clip-ring FALLBACK`).

## Measurements (101, live hub, 2026-08-08)

The camera's ladder: `high` 3840×2160 h264, `mid` 1280×720 h264, `low` 640×360
h264. Every number below came from the live broker, not a fixture.

| what | before | after |
| --- | --- | --- |
| gif source rendition | `low` — 640×360 (cheapest assigned) | `mid` — 1280×720 (largest H.264 ≤ 1080p) |
| gif geometry | 480×270, 5 fps at 2× speed (2.5 source fps) | 640×360, 12 fps at 4× speed (3 source fps) |
| gif weight / frames | 189 KB / 24 frames | see "the gif plays at 4×" below |
| gif encode time | (broker render) | 0.50 s from the mp4 |
| mp4 | `libx264 -crf 28`, 480 px, `-an` | `libx264 -crf 23` at ≤720p, 4× (see below) |
| mp4 weight | — | 260 KB for a 12.1 s window (3.1 s of playback) |
| window | gif [evt−3 s, evt+5 s], mp4 [evt+7 s, evt+13 s] | ONE window, [evt−4 s, evt+6 s] |

The palette pair (`palettegen=stats_mode=diff` + `paletteuse=dither=bayer`) was
already in the ring renderer and is unchanged. **The de-pixellation was the
source rendition, not the quantiser** — worth remembering the next time a gif
looks bad.

## Both containers play at 4×

Operator call, 2026-08-08: a notification is *glanced at*. A ~12 s window that
takes 12 s to watch is skipped, so **both** the gif and the video default to
**4×** — that window is over in ~3 s. Verified on one live 101 production, which
is the whole point of a single production point:

| artifact | geometry | duration | frames | rate | bytes |
| --- | --- | --- | --- | --- | --- |
| mp4 | 1280×720 | **3.08 s** | 77 | 25 fps | 260 KB |
| gif | 640×360 | **3.08 s** | 37 | 12.5 fps | 302 KB |

One window of 12.063 s, `12.063 / 4 = 3.016`. Same window, same rendition, and
now the same timeline.

### The video's 4× costs the copy branch, and that was priced before it was taken

`speed !== 1` fails `clipCanCopy`, so a sped-up video cannot be the camera's own
H.264 copied — it is a `libx264` burst. That is a per-event burst over a ~12 s
window, **not** a permanent transcode child; [D84](../decisions/adr-0084.md)
priced the latter at 89.9 % of a core against 0.7 % for a copy and is not the
thing being traded here.

Encode tuning, measured on a real 101 720p cut with `-preset veryfast`:

| | crf 23 | crf 26 | crf 28 |
| --- | --- | --- | --- |
| 1280 wide | 254 KB / 0.23 s | 191 KB / 0.23 s | 145 KB / 0.23 s |
| 640 wide | 57 KB / 0.21 s | 43 KB / 0.21 s | 35 KB / 0.21 s |

**The time is flat across crf** — the preset buys the time, the crf only buys
bytes. So `EVENT_CLIP_CRF` is 23, not the 28 this used when the encode was a
fallback nobody chose: a notification video is looked at, and every cell above is
far under the smallest cap any notifier declares (pushover's 5 MiB).
`eventClipEncodeWidth` caps a re-encode at 720p — once a speed has forced the
decode the width stops being free — but leaves the source width alone at real
time, because the identity scale is exactly what `clipCanCopy` looks for.

**The re-encode is smaller than the copy it replaces.** Paired runs on the live
hub, `mid` rendition, mp4 only:

| | wall (incl. the 6 s post-roll wait) | bytes |
| --- | --- | --- |
| `speed: 1` → `copy` | 6118 / 6968 ms | 697 KB / 697 KB |
| `speed: 4` → `encode` | 6782 / 6454 / 6512 ms | 271 / 260 / 279 KB |

The burst adds **~40 ms** to a call whose wall time is dominated by waiting out
`postSeconds` — it is not visible in delivery latency, and it is 2.6× fewer bytes
to push to a phone. At the `low` rendition the encode is 48 KB against 156 KB and
the wall times are indistinguishable.

### Where each default lives

| knob | default | where the default lives |
| --- | --- | --- |
| `gifSpeed` | 4 | the cap schema **and** `GIF_SPEED` in the broker provider |
| `gifFps` | 12 (the gif's PLAYBACK rate) | the cap schema; `NC_GIF_FPS` sends it explicitly |
| `speed` (video) | 4 | the cap schema; `DEFAULT_SPEED` in the NC sends it explicitly |

`speed` and `gifSpeed` stay SEPARATE knobs even though both now default to 4: a
rule that asks for a real-time video still gets one, and gets the copy branch
with it.

The duplication on `gifSpeed` is deliberate and was verified live. A Zod
`.default()` on a cap input is applied by the **hub's** router, which ships
inside `@camstack/system` and therefore lags an addon deploy by a whole publish
train (`CAP_INPUT_DEFAULTS`). Measured on the hub right after deploying the addon
alone: a call omitting `gifSpeed` entirely still came back **4×** (the provider's
own default) but at 8 fps (the hub's stale `gifFps`). `speed` needs no provider
twin because every hub route supplies it — stale or fresh — and the NC overrides
it explicitly either way.

### `setpts` does not move the frame rate — the muxer will undo your speed-up

This cost a measurement to find and is the reason the filter names `fps` twice.
`fps=3,setpts=PTS/4` produces the right *duration* and the wrong *film*: `setpts`
rewrites the timestamps but leaves the filter link still advertising 3 fps, and
the gif muxer honours the link. Measured on a live 101 window, all at 640 px from
the same source:

| filter | duration | frames | bytes |
| --- | --- | --- | --- |
| `fps=8` (real time, the previous default) | 12.26 s | 98 | 401 KB |
| `fps=3,setpts=PTS/4` | 3.01 s | **10** | 466 KB |
| `fps=3,setpts=PTS/4,fps=12` | 2.33 s | 28 | **312 KB** |

Note the middle row is BIGGER than either. A gif delta-codes against the previous
frame through transparency; frames four seconds of real time apart share nothing
to delta away, so ten frames cost more than twenty-eight. Both renderers now
re-declare the rate after `setpts` — `gifFilterComplex` and the ring's
`clipFfmpegArgs` gif branch. The mp4 branch deliberately does not: its muxer
writes the timestamps it is given, and pinning a rate there would duplicate or
drop frames.

Net against the previous default, same rendition and same geometry: **5.3×
shorter, 71 % fewer frames, 22 % fewer bytes.**

Frame-rate note for the copy branch: ffmpeg's `h264` demuxer takes the frame rate
from the SPS VUI when the camera writes one, and every camera on this fleet does
(verified with `ffprobe` on the muxed output: `10/1` for 101's 720p slot).
`-framerate` on the input does NOT override it — measured. A camera with no VUI
timing would be muxed at ffmpeg's 25 fps default and play fast; the produced log
line carries the packet count and the coverage span, which is what that would
show up in.

## What the clip ring costs, and why it is not gated further yet

`StreamBroker.setClipRetention` allocates an `EncodedRingBuffer` **only while
retention is armed**, and `applyClipRetention` arms exactly one profile per
camera by default — the cheapest — plus any profile a clip has actually been
asked from (`clipRetentionArmed`, remembered across catalog reconciles). So the
ring is **already per-camera and per-profile gated**; it is not a fleet-wide
allocation over every rendition.

The measured footprint is the 25 s window times the rendition's bitrate:

| rendition | 25 s of AnnexB |
| --- | --- |
| 640×360 substream | ~1.5 MB |
| 1280×720 | ~6 MB |
| 3840×2160 | ~40 MB |

Asking a production for the `mid` rendition arms `mid` retention on that camera
permanently — about +4.5 MB per camera with a clip rule, and only for those. On
this install that is one camera. **Nothing further was gated in this round**
because there is nothing left that is fleet-wide: turning the default arming off
for cameras with no clip rule would need the broker to know the rule set, which
means a cap method and a reconcile — a real feature, not a tidy-up. It is worth
doing only if the substream ring ever shows up in a heap profile; at ~1.5 MB per
camera it will not.

## The road to ONE path

The fallback exists for exactly three reasons. Each has a fix, and none of them
is "keep both paths forever".

1. **A hub older than the method.** Self-closing: the fallback is dead code the
   moment every node runs a `@camstack/server` carrying `produceEventMedia`.
   Delete it then, and delete `renderPreBufferClip`'s gif branch with it.

2. **An H.265-only camera** (e.g. 112). Two options, in the operator's order of
   preference:

   - **(a) Give it an H.264 substream.** A camera configuration change, not a
     code change. Every camera on this fleet that offers H.265 also offers a
     second slot; enabling H.264 on it makes the camera copyable and removes it
     from the fallback permanently. This is the preferred road because it costs
     nothing at runtime and it is what makes the notification playable on the
     phones it lands on regardless of path.
   - **(b) A PER-EVENT transcode branch in the production.** A short burst at
     the event — never a permanent transcode child, which
     [D84](../decisions/adr-0084.md) priced at 89.9 % of a core against 0.7 %
     for a copy. The production already knows it cannot copy
     (`clipCanCopy` returns false with the reason); the branch is
     `-c:v libx264 -preset veryfast` over the same window, for the length of the
     window. Bounded and honest, and it makes the ring's H.265 handling
     redundant. Not built: (a) removes the need on this install, and a transcode
     branch nobody exercises is a branch nobody has verified.

3. **A moment the ring does not cover.** Not a path, a fact — the ring fills
   only while something else holds the camera dialed. The production reports
   `coverage.{fromTs,toTs}` precisely so a short clip is visible as a short clip
   rather than blamed on the encoder.

## Open, and deliberately so

- **The produced clip has no audio.** The AnnexB clip ring retains video
  packets; the deleted fMP4 seam carried in-band AAC. Closing this means
  retaining audio packets alongside and muxing a second input in
  `renderPreBufferClip` — a broker change of moderate size, and the right one.
  It is NOT a reason to run a second fragmenter: the window is worth more than
  the audio, and the window is what the operator reported.
- **The pre-roll is bounded by what the ring held.** 25 s today, arming
  opportunistically. If a rule ever asks for more pre-roll than the ring can
  hold, the depth becomes a setting with the per-second cost above as its
  honest label.
- **`produceEventMedia` is called UNPINNED**, exactly as `renderPreBufferClip`
  was. On a cluster whose ingest owner is not the hub, the hub's broker holds no
  ring for that camera and the production throws — falling back correctly, but
  for the wrong reason. The fix is `pipelineOrchestrator.getIngestOwner` plus
  `nodePin` on the production call, the same pattern the recorder and the
  snapshot addon already use. The FETCH is already pinned, via
  `artifact.nodeId`.
