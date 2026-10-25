---
id: D459
title: One G.711, one amplitude — and the instant it changed is named, never compensated
status: accepted
date: 2026-09-11
applies-to:
  - packages/addon-pipeline/src/stream-broker/rtsp/audio-rtp-decoder.ts
  - packages/types/src/audio/audio-scale-epoch.ts
covers:
  - packages/addon-pipeline/src/stream-broker/stream-broker/g711-mulaw.ts
last-verified: 2026-09-11
---

## Context

This repo decoded G.711 twice, and only one of them was right.

| file | consumer | formula |
| --- | --- | --- |
| `stream-broker/stream-broker/g711-mulaw.ts` | WebRTC/Opus egress — **what the operator hears** | ITU-T, correct |
| the tables in `stream-broker/rtsp/audio-rtp-decoder.ts` | the audio chunk plane — **the classifier and the dBFS meter** | wrong |

Verified over all 256 codes, both laws, against an ITU-T expansion written
independently of either implementation:

| law | shipped peak | ITU-T peak | ratio | dB |
| --- | --- | --- | --- | --- |
| μ-law (PCMU) | 0.2451 | 0.9803 | **×4.000000** on every code | −12.041 |
| A-law (PCMA) | 0.1230 | 0.9844 | **×−8.000000** on every code | −18.062 |

`((2·m + 33) << e) − 33` is exactly `((8·m + 132) << e) − 132` divided by four.
It is not an approximation: minimum and maximum ratio are identical.

**A-law was wrong twice.** Its magnitudes were built on a 13-bit scale and
never shifted to 16 (the extra octave), *and* its sign was inverted — after the
`^ 0x55` even-bit inversion, bit 7 SET means POSITIVE in G.711, the opposite of
μ-law, and the shipped table used the μ-law convention. A phase inversion is
inaudible and leaves an RMS/dBFS reading untouched, which is why it sat
unnoticed next to the gain defect rather than being caught by it.

**Why it survived.** The split is the whole explanation: the audio an operator
LISTENS to came out of `g711-mulaw.ts` and was right. The audio the detector
MEASURES came out of the chunk plane and was four to eight times quieter. Every
complaint about audio would have been about the first path and found nothing.

The corroboration is sitting in the repo, in the one calibration that recorded
its provenance — `NC_AUDIO_DB_OFFERED`'s JSDoc: *"measured on the live
installation, real crying sits between −55 and −26 dBFS."* On a true dBFS scale
a close cry is around −20; −55…−26 is about 12 dB low, which is exactly μ-law's
factor.

**And that is the trap the fix walks into.** Correcting the decoder raises every
level measurement on every native G.711 camera by 12 or 18 dB in one step. Every
absolute-dBFS gate authored against the old scale becomes 12–18 dB too
permissive at the same instant — a `dbThreshold: -55` notification rule whose
camera's ambient now reads −43 matches 100 % of its samples, and a recording
band with an audio trigger records continuously. Shipping the correction alone
is a worse failure than the defect.

## Decision

**The decode is ITU-T G.711 at the source, and nothing downstream compensates.
The scale change is a named instant, not a gain.**

Three parts, and the third is a refusal.

1. **The tables are corrected in `audio-rtp-decoder.ts`** — μ-law magnitude
   `((8·m + 132) << e) − 132`, A-law `16·m + 8` / `(16·m + 264) << (e − 1)` with
   bit 7 SET meaning positive. The anchor is `g711-itu-scale.spec.ts`, which
   compares against an ITU-T expansion written from the standard **and only
   then** against `g711-mulaw.ts` — "the two implementations agree" goes green
   the moment both are wrong the same way, so it can never be the primary
   check.

2. **`AUDIO_SCALE_EPOCH_MS` and `G711_SCALE_CORRECTION_DB` are one module in
   `@camstack/types`** (`audio/audio-scale-epoch.ts`). The factors are DERIVED
   (`20·log10(4)`, `20·log10(8)`) — arithmetic on an exact ratio, never an
   estimate — and the epoch names the day, not a deploy minute, because the
   correction reaches each node when that node's `addon-pipeline` is
   redeployed. `audioScaleEraOf` answers `pre-itu | itu | unknown`, and
   `unknown` never collapses into `itu`: a row with no usable timestamp carries
   no claim about its scale (D393).

3. **No threshold is shifted, and no history is rewritten.** Both refusals have
   the same cause, stated in full below.

### Why the thresholds are not shifted

The affected gates are of two kinds and neither can be moved correctly from
here.

**Shared constants** — `SILENCE_FLOOR_DBFS = -55`, `NC_AUDIO_DB_OFFERED = -55`,
the viewer's six-rung ladder `[-60,-53,-46,-39,-32,-24]`, `dbfsToUnit(floor=-60)`.
Each is ONE number serving BOTH camera populations. An AAC/Opus camera was
always on the correct scale, so the value that preserves yesterday's behaviour
on a G.711 camera is a new and different behaviour on every other one. There is
no single number that is right for both, and inventing one by eye is the move
that wrote this defect.

**Per-object stored values** — `NcAudioCondition.dbThreshold` (per rule),
`RecordingTriggers.audioThresholdDbfs` (per device per band),
`audioMarkerMinDbfs` (per device), the viewer's `GridHighlightSettings.audioDb`.
These COULD be shifted exactly, because the factor is known per law. They are
not, because the law is not known per camera **anywhere a migration could read
it**: `DecodedAudioChunk` carries four fields and no codec, `AudioWindowFormat`
tracks `{ sampleRate, channels }` only, and the broker's `audioCodec` is
discovered from the SDP at session start and never leaves the process. The only
durable proxy is `StreamMetadata.audio.codec` from an ffprobe that may be
absent, stale, or taken on a different profile — and it cannot be trusted to
decide whether to move an operator's hand-written number by 12 dB.

So the instrument comes first: **`audio: track detected` and `native: audio
decoder initialized` now carry `tags: { deviceId }`**, and the second states
`preD459LevelDeficitDb` for that camera. It is the only line in the system that
knows which law a camera speaks. With it the fleet can be enumerated per camera
and each stored threshold moved by a number instead of a guess — as an operator
action, with the codec census in hand.

### Why history is declared, not re-labelled

A stored `AudioEvent.dbfs` from before the epoch is 12.04 dB low if its camera
spoke PCMU, 18.06 dB low if PCMA, and correct if AAC or Opus. **The row does not
say which.** The codec was never on the chunk, never on the analysis result and
never on the event. Re-labelling would mean assigning one of three corrections
per row from evidence that does not exist — guessing, at the scale of the whole
archive, on data that is then indistinguishable from measurement.

So history is left exactly as recorded, and the discontinuity is named instead.
A graph spanning 2026-09-11 shows a step on the affected cameras; `AudioScaleEra`
is what a reader consults to say why, and the constant carries the two numbers
the step can be.

## Consequences

- **The correction is not releasable on its own.** Between the decoder landing
  and the per-camera threshold pass, level-mode notification rules and
  audio-triggered recording bands on native G.711 cameras will over-fire by
  12–18 dB of margin. This ADR is the statement that the second half is
  outstanding, not the statement that it is done.
- Absolute-dBFS gates now mean one thing across the fleet instead of two. That
  is the durable win, and it is why no compensating gain was added: a second
  authority arguing with the decoder would put the two scales back.
- `classificationMinScore` / `minConfidence` are NOT re-scalable in any
  direction. The classifier's input amplitude moved by 12–18 dB on the affected
  cameras, so its output scores change in a way no multiplication describes.
  Whether YAMNet's labelling improves (it was trained on real-scale audio, and
  a 4× attenuation is a real handicap) or its false-positive rate rises must be
  measured, not predicted.
- Relative gates are untouched and provably so: `levelDeviationDb`,
  `audioMarkerMinDeviationDb`, `audioMarkerMinDeviations`,
  `audioMetricsReportThresholdDb` and the anomaly detector's EWMA/MAD compare a
  sample to the same camera's own recent mean. A uniform offset cancels.
- `NC_AUDIO_DB_OFFERED`'s JSDoc is now marked as a pre-epoch measurement. The
  open question it raises — which camera the crying was measured on — is for
  the operator, and the new log line is how it gets answered.

## Enforcement

`packages/addon-pipeline/src/stream-broker/__tests__/g711-itu-scale.spec.ts`
drives the real `AudioRtpDecoder` over all 256 codes of both laws and compares
against an in-test ITU-T expansion, plus the standard's published constants
(±32124 μ-law full scale, ±32256 / ±8 A-law). It goes through the decoder, not
through the table functions, so it keeps guarding the behaviour wherever the
tables end up living — including after D455's move into `@camstack/types`.

`packages/types/src/audio/__tests__/audio-scale-epoch.spec.ts` pins the two
factors to their derivation and pins `unknown` to never collapse into `itu`.

Three disarms were run and each produced the expected red: the μ-law magnitude
(5 failures, including two bounds in the pre-existing decoder spec that had to
be tightened from `> 0.2` — they passed just as happily on the broken table),
the A-law sign alone (2 failures), the A-law magnitude alone (3 failures). Two
more on the epoch module: collapsing `unknown` (1) and equating the two factors
(3).

What is NOT enforced: nothing stops a new absolute-dBFS constant being added
without a note about which era it was calibrated in. A guard would need to know
which numbers are levels, and it does not.
