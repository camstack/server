# The motion area bar — measured, per camera

Measured 2026-09-07 on **four cameras that record continuously** (101
*front door*, 102 *parking*, 1441 *retro casa*, 104 *hall*), 20 minutes of
day (14:00 UTC) and 20 minutes of night (01:00 UTC) each — **37 512 analysed
frames, 160 minutes of real footage**. Plus the human-read ground truth from
[`motion-crop-recall.md`](motion-crop-recall.md): 38 frames on camera 101 with a
visually confirmed animal.

> The recall report this builds on has not landed on `main` yet — it lives on
> the branch that produced it (`worktree-agent-a0160034cb846f2d5`), together
> with its harness and the ground-truth corpus quoted below. Every link to it
> here resolves once that branch merges.

Harness: `scripts/motion-region-area-eval.mts` (`scan` / `subjects` / `report` /
`gt`; what each measures is in its docblock). No detector, no pipeline, no
settings write — footage is read through `recording.readSegmentBytes` and run
through the real `packages/addon-pipeline/wasm/motion.wasm` at the real motion
cadence. Raw scans stay under `scratchpad/motion-area/` (gitignored).

This answers the question [`motion-crop-recall.md`](motion-crop-recall.md)
refused to answer by copying a number:

> Decide `minArea` (and whether the motion view should be larger than 320×180
> at all) from a measured distribution, per camera, not by copying 500 out of
> this page.

The rule it produced is [D394](../decisions/adr-0394-the-motion-area-bar-judges-a-merged-subject-relative-to-the-view.md).

## The input is the `low` profile, not a downscaled 4K frame

The recall report's biggest caveat was that its motion input was the 4K `main`
recording downscaled, while production motion reads the camera's `sub` stream.
Here the `low` profile **is** the sub stream — 640×360 with the same
compression noise — so this corpus is what the live motion step actually sees.
It is also 50× cheaper to pull (200 KB per 12 s segment against 10 MB), which
is why 160 minutes of it was affordable.

## The motion view is not one size, and that is the first finding

`MOTION_FRAME_VIEW` is `content 320×320, fit contain`. Probed per camera:

| camera | source | motion view | area | what `minArea 1500` means there |
| --- | --- | --- | --- | --- |
| 101, 102, 104 | 640×360 | 320×180 | 57 600 px | 2.60% of the frame |
| 1441 | **1200×536** | **320×142** | **45 440 px** | **3.30% of the frame** |

The shipped absolute bar was already 27% stricter on 1441 than on its
neighbours, and nothing said so. A camera swapped for one with a different
aspect ratio re-tunes its own motion sensitivity, silently. That alone settles
the units question independently of any recall number.

## Distribution 1 — human ground truth, camera 101

38 frames with a visually confirmed animal, against 3 032 frames of quiet and
adversarial footage from the same camera. Largest **merged** region per frame:

| | n | min | p10 | p25 | med | p75 | p90 | max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| animal present | 35 | 555 | 1007 | 1220 | 2034 | 3284 | 5362 | 8727 |
| quiet | 29 | 696 | 870 | 1146 | 1900 | 3172 | 4487 | 5685 |

**The two distributions do not separate.** They are the same distribution. What
separates a subject frame from a quiet frame on this camera is not how big the
region is — it is whether there is a region **at all**: 35 of 38 positive
frames have one, against 29 of 3 032 quiet frames (1.0%). Three positive frames
have no connected component at any size, and no area bar can recover those.

That is the honest answer to "choose the default where the two distributions
separate": **there is no such point**, on any of the four cameras (see below).
So the bar is chosen on the only criterion the data supports — *the largest bar
that still holds recall at its ceiling* — and the quiet-side cost is reported
rather than optimised.

### Shape versus value

| rule | positive (38) | quiet (3 032) |
| --- | --- | --- |
| per-region, 1500 px — **shipped** | 19 (50%) | 15 (0.49%) |
| merged, 1500 px | **23 (61%)** | 19 (0.63%) |
| per-region, 490 px | 35 (92%) | 27 (0.89%) |
| merged, 490 px | 35 (92%) | 29 (0.96%) |

Merging alone, at the shipped bar, buys **+11 points**. The value buys the rest.
Both matter, and only the first is free: at a fixed bar, merge-then-judge costs
4 extra firing frames in 3 032 (0.14 points) for 4 recovered positive frames in
38. Of the 37 groups that pass at the chosen bar on positive frames, **9 are
made of more than one component** — those are the subjects a per-component bar
was discarding three times over.

### The sweep

| bar | px @320×180 | positive | quiet |
| --- | --- | --- | --- |
| 0.20% | 115 | 35/38 | 29/3032 |
| 0.60% | 346 | 35/38 | 29/3032 |
| **0.85%** | **490** | **35/38** | **29/3032** |
| 1.00% | 576 | 34/38 | 29/3032 |
| 1.25% | 720 | 34/38 | 28/3032 |
| 1.56% | 899 | 33/38 | 26/3032 |
| 2.00% | 1152 | 28/38 | 21/3032 |
| 2.60% | 1498 | 23/38 | 19/3032 |

Recall is at its ceiling (35/38 — the ceiling is CCL, not the bar) everywhere at
or below **0.85%**, and starts falling at 1.00%. Below 0.85% nothing improves:
going all the way to 0.20% fires on exactly the same frames. So 0.85% is the
*largest* bar at full recall, which is the conservative choice — every point
lower is exposure bought for nothing.

## Distribution 2 — the fleet, against production's own conclusions

On the four scanned cameras "a subject was present" is taken from the
`pipelineAnalytics.getObjectEvents` rows for the same window — what the live
detector actually concluded. A **proxy**, and a conservative one: it can only
mark frames the full-frame pass already succeeded on, which is precisely the
population this work exists to enlarge.

Largest merged region per frame, as a share of that camera's motion view:

| camera | subject frames (with a region) | med | p90 | quiet frames (with a region) | med | p90 | max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 101 | 178 (33) | 3.57% | 9.01% | 9 200 (108) | 2.10% | 4.07% | 15.6% |
| 102 | 56 (32) | 3.49% | 10.11% | 9 322 (189) | 2.39% | 5.69% | 10.3% |
| 1441 | 0 (0) | — | — | 9 363 (321) | 2.81% | 3.56% | 6.6% |
| 104 | 161 (97) | 2.70% | 4.36% | 9 212 (**4 212**) | 3.44% | 23.46% | **99.9%** |

Again no separation — and on 104 the quiet median is **larger** than the subject
median. Area does not tell a subject from a non-subject anywhere on this hub.

The knee is nonetheless in the same place on every camera. Subject frames the
rule fires on:

| bar | 101 | 102 | 104 |
| --- | --- | --- | --- |
| 0.20–0.85% | 33/178 | 32/56 | 97/161 |
| 1.00% | 32 | 32 | 97 |
| 1.25% | 30 | 31 | 97 |
| 1.56% | 28 | 30 | 94 |
| 2.00% | 24 | 29 | 81 |
| 2.60% (≈ shipped) | 22 | 26 | 53 |

**A single relative constant fits the fleet: 0.85% of the motion view** —
490 px at 320×180, 386 px on 1441's 320×142. It is the largest value at which
every camera measured is still at its recall ceiling, and the smallest value
that gives up nothing.

## The cost — motion duty cycle, per camera

Duty cycle here is the fraction of wall-clock time the runner would sit in
`active`: every firing frame arms `motionCooldownMs` (30 s), and overlapping
arms are unioned. It is the quantity that turns into accelerator time,
notification exposure and — on a camera whose bands are `events` +
`triggers.motion` — recorded hours.

| camera | shipped (per-region 1500) | D394 @ 0.85% | delta | ×  |
| --- | --- | --- | --- | --- |
| 101 front door | 11.53% | 16.73% | +5.2 pp | ×1.45 |
| 102 parking | 15.51% | 26.35% | +10.8 pp | ×1.70 |
| 104 hall (indoor) | 84.95% | 95.78% | +10.8 pp | ×1.13 |
| **1441 retro casa** | **15.75%** | **44.46%** | **+28.7 pp** | **×2.82** |

Frames firing goes 60→139 (101), 105→218 (102), 2373→4305 (104) and **25→321**
(1441).

### What that costs in recorded hours

**On these four cameras: nothing.** All four record `continuous`, so their
storage is a function of the clock, not of motion. Checked across the fleet on
the hub: **8 cameras record continuous, 10 record `events` with a motion
trigger, 10 have recording off.** The recorded-hours cost lands entirely on
those ten — 1436, 1438, 1439, 3628, 3629, 3825, 3831, 3833, 3836, 3838.

And it **cannot be measured on them from their own footage**: an events-mode
camera only has recordings for the windows that already triggered, so there is
no counterfactual on disk. Transferring the measured deltas to them, a
motion-triggered camera resembling 101/102 would record roughly **1.5× to 1.7×
the hours** it does today, and one resembling 1441 close to **2.8×**. Those are
estimates, and they are the reason for the rollout advice below.

## The storm breaker

There was **no storm guard anywhere on this path** before D394: not a max
region count, not an area-fraction ceiling, not a whole-frame-change detector,
not a rate limit on motion events, not a ceiling on how often the phase machine
may re-arm. The only things between a rain frame and a full detection session
were the per-component area filter, optional zone rules, and a 30 s cooldown
that a storm continuously re-arms rather than being limited by. Merge-then-judge
makes that worse by design — it is very good at coalescing weather.

Measured: a merged group covering more than 25% of the view occurs on **0 of
28 119 frames** on 101, 102 and 1441. On 104 — an indoor room with lights, a
screen and an IR cut — it happens on 388 frames, over 50% on 121, and over 70%
on 45, peaking at **99.9% of the view**.

At the chosen bar, with the cutoff at 50%:

| camera | groups suppressed | frames that still fired on a component | subject frames lost | duty cycle change |
| --- | --- | --- | --- | --- |
| 101 / 102 / 1441 | 0 | 0 | 0 | none |
| 104 | 120 | 80 | **0** (97/161 either way) | none (saturated) |

So the breaker is a genuine safety net: on three cameras it never fires, and on
the fourth it removes 120 whole-frame changes while costing **no subject frame
at all** — because a suppressed group is re-judged component by component, and
a real mover inside the storm still fires on its own component. **0.5 is the
default**; 0.7 would catch only the 45 most extreme frames, 0.25 would start
suppressing legitimate close subjects on 104.

## The merge radius

`r = min(viewW, viewH) / 6`, taken from the reference NVR — because it is a merge
*distance*, not a bar. Swept over 1/4, 1/6, 1/8 and 1/12 on the ground-truth
corpus: the positive distribution is **identical** from 1/6 downward (min 555,
med 2034, p90 5362, max 8727) and only 1/4 differs (its wider radius merges the
smallest positive up from 555 to 851). The quiet distribution is unchanged in
count at every divisor; only its smallest region moves (696 px at 1/4 and 1/6,
448 px at 1/8 and 1/12). Nothing here is worth tuning, so 1/6 stands.

## Limits — read these before quoting the numbers

- **Two 20-minute windows per camera, one day, four cameras.** Diagnostic
  sample. No rain, no wind, no snow fell during it — the storm numbers come
  from an indoor camera's lights and IR cut, which is the same *shape* of event
  but not the weather case the breaker exists for.
- **The fleet "subject" label is production's own output**, so it marks only
  what the current detector already finds. Subject-frame counts here are a
  lower bound on both sides and must not be read as recall.
- **1441 has no subject events in 160 minutes** and the largest duty-cycle
  increase of the four. Its motion population is a tight band (p25 2.4%,
  p90 3.6%, max 6.6% — 321 frames) with no confirmed subject behind any of it:
  that is persistent scene noise sitting right at the shipped bar, and lowering
  the bar admits all of it. It is the camera that most needs an operator's eyes
  before a fleet-wide change, and the best candidate for a `minAreaOverride`.
- **Duty cycle is modelled**, not observed: it applies the 30 s cooldown union
  to the frames the rule fires on. It is the right shape for detection-session
  cost; recorded hours on an events-mode camera additionally depend on that
  band's window and buffers.
- **The `low` profile is the right input but not identical to the live one** —
  the live path decodes the sub stream directly, this decodes a recording of
  it. Same pixels, one more re-encode.

## A caveat about production history, not about these numbers

Until [D394](../decisions/adr-0394-the-motion-area-bar-judges-a-merged-subject-relative-to-the-view.md)
one `WasmMotionDetector` served every camera on a node and was sized for
whichever camera called `init` last. Three frame sizes are live on this hub, so
an affected camera has been analysed at the wrong dimensions — in one direction
producing 76.4% of the buffer as changed pixels from two IDENTICAL frames
(permanent motion), in the other reading only a sheared strip of the top of the
picture (a subject in the bottom half invisible). Details and evidence are in
that record.

**These measurements are unaffected**: the harness runs the WASM out of process,
one camera at a time, sized from that camera's own frames. What is affected is
anything read out of PRODUCTION about motion — duty-cycle history,
motion-event counts, "camera X fires too much". The `shipped rule` column above
is therefore what the shipped rule *should* have done; on an affected camera
production did worse.

## Decision

**Ship the shape everywhere, enable it one camera at a time — and make that the
only thing deployment can do.**

The default is the rule that shipped: `minArea 1500`, per component, no merging,
no storm cutoff. Installing the addon changes nothing on any of the 28 cameras.
An operator moves ONE camera by setting its `minArea` to **0**, which hands it
to the measured rule.

- `minAreaFraction` **0.0085** (0.85% of the motion view) once a camera is
  moved, from the knee measured on every camera. Recall at its ceiling, and
  nothing gained by going lower.
- `maxCoverageFraction` **0.5**, live for a moved camera. It costs nothing
  measurable and it is the only storm protection this path has ever had.
- Merge radius divisor **6**, taken from the reference NVR, and the verdict is
  insensitive to it.
- **Move camera 101 first** — it is the camera the recall work was done on, it
  records continuously so the change cannot cost storage, and its duty cycle
  moves the least (+5.2 pp). Watch it for a week before touching a
  motion-triggered camera.
- **1441 last, if at all.** It is the one camera where the measurement says
  "this will nearly triple your motion" and cannot say what the extra motion is.
  Leaving its `minArea` at 1500 is now the default rather than a remedial step.

The end state is still one relative constant for the whole fleet. What the
default buys is that the walk there is one camera at a time, by construction.

### Moving one camera

```
motionDetection.applyDeviceSettingsPatch  { deviceId: 101, patch: { minArea: 0 } }
```

or, in the UI, the camera's **Detection → Min Area** field set to `0`. That is
the whole gesture; `minAreaFraction` and `Storm Cutoff` come from the defaults
above and only need touching to deviate from them.

**Order matters, and getting it wrong is loud.** On the addon that is deployed
TODAY, `minArea: 0` means `pixels >= 0` — no filter at all, every connected
component fires motion. The patch is only safe once a build containing D394 is
the one the node is running. Deploy first, confirm the version, then patch.

On the next analysed frame the addon logs, with `tags.deviceId`:

```
motion area rule resolved  { rule: 'merged-relative', minArea: 0,
                             minAreaFraction: 0.0085, maxCoverageFraction: 0.5 }
```

A camera nobody has moved logs `rule: 'legacy-per-region', minArea: 1500` the
first time it resolves. The line is emitted only when the resolved rule
*changes*, so it is one line per camera per change, not one per frame.
