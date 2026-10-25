---
id: D281
title: A raw-PCM talk frame at the wrong sample rate is CONVERTED by the audio-codec cap or refused loudly — the provider decides, the cap does the arithmetic
status: accepted
date: 2026-08-28
supersedes:
applies-to:
  - packages/addon-decoder-nodeav/src/audio-codec/codec-catalog.ts
  - packages/addon-decoder-nodeav/src/audio-codec/nodeav-av-types.ts
  - packages/addon-provider-hikvision/src/intercom/talk-pcm-transcoder.ts
  - packages/addon-provider-reolink/src/talk-pcm-transcoder.ts
  - packages/addon-provider-hikvision/src/intercom/intercom-failure-report.ts
  - packages/addon-provider-reolink/src/intercom-failure-report.ts
  - scripts/check-intercom-rate-refusal.ts
---

## Context

Both intercom providers carried the same branch, word for word:

> `intercom: s16le sampleRate mismatch (PCM-only resample not implemented) — dropping`

Hikvision's ISAPI two-way audio is fixed at 8 kHz. Reolink's talk channel is
typically 16 kHz. **HomeKit and Alexa raw-PCM talk-back went through that branch
today**, and every rate-mismatched frame was lost with one `warn` and no
counter — so "how much talk-back is 102 losing" was answerable only by grepping
Loki, and a bare drop count could not have answered it either.

The refusal itself was RIGHT and was made on purpose: playing 22 050 Hz samples
into an 8 kHz channel is chipmunk audio, and wrong audio is worse than none. The
comment named exactly what was missing. What was missing was the conversion.

**The conversion had nowhere to happen.** `intercom.cap.ts` promises callers
that the provider will "transcode via the `audio-codec` cap", and the
`audio-codec` catalogue had no linear-PCM entry — `pcm_mulaw`, `pcm_alaw`,
`g722`, `aac`, `aac_latm`, `opus`, and a docblock stating `l16` / `pcm_s16be`
were out of scope. So the provider had nothing to call, and the promise in the
cap file was a promise nobody could keep.

Three things were checked before writing any of it, and two came back different
from what the design document assumed:

- **node-av's typed constants DO expose linear PCM.** `AV_CODEC_ID_PCM_S16LE`
  (65536) and `AV_CODEC_ID_PCM_F32LE` (65557) exist on the real
  `node-av/constants`, so `resolveAvCodecId` needed two cases and no adapter.
  `packages/addon-decoder-nodeav/src/audio-codec/__tests__/nodeav-av-types.spec.ts`
  asserts it against the installed module, not a stub — a stub answers whatever
  it was written to answer.
- **The two catalogues were in step where it counted, and had already drifted
  where nobody could see.** The advertised lists (`codec-catalog.ts:53` and the
  copy in `decoder-ffmpeg`'s `provider.ts`) were identical, seven entries in the
  same order. But `decoder-ffmpeg`'s INTERNAL `DECODE_FORMAT_BY_CODEC` already
  carried `pcm_s16le` and `pcm_s16be` — a latent capability the catalogue gate
  in `createDecodeSession` made unreachable. Nothing checked either statement.
- **Wyze is a different shape and was left alone.** `wyze-camera.ts:361`
  destructures `pushTalkAudio` WITHOUT `codec`, and forwards
  `sampleRate ?? backchannel.sampleRate` into `writeAudio`, which stamps the
  caller's rate into the frame header and writes the payload verbatim under the
  backchannel's codec id. There is no drop branch to replace: the defect there
  is that a mismatched CODEC is accepted silently, on a hand-rolled DTLS
  backchannel the file itself marks experimental. Fixing it needs a camera to
  test against, not this change.

## Decision

**Linear PCM is in the `audio-codec` catalogue, and a rate-mismatched raw-PCM
talk frame goes through it.**

1. `pcm_s16le` and `pcm_f32le` are catalogue entries in **both** providers of
   the singleton, decode and encode. A `{pcm_s16le, 22050 → 8000, s16le}`
   decode session is a pure libswresample pass — the codec stage is a
   passthrough. **No resampler is written anywhere**, and no file added by this
   record contains sample-rate arithmetic. `l16` / `pcm_s16be` stay out: RTP L16
   is big-endian, nothing here produces it, and adding it would be a byte-order
   claim nobody has tested against a camera.
2. **The provider decides the conversion is needed; the cap performs it.** The
   camera's rate never leaves the provider — that is the promise
   `intercom.cap.ts` makes and it still holds. `TalkPcmTranscoder` copies the
   `opusDecode` discipline already in both files: lazily created on the first
   frame that needs it, keyed by source rate, reused, and torn down **with the
   talk session and on error**. A caller that renegotiates its rate gets a new
   session, never a mislabelled old one.
3. **Refusal survives, and it is louder than before.** Every path that cannot
   convert returns a named reason, logs it with `tags: { deviceId }`, and feeds
   the transport NOTHING. Silent success at the wrong rate is the one outcome
   this must never produce, so the transcoder owns the feed: bytes reach the
   camera only after the codec cap handed them back.
4. **Both outcomes are counted, per camera, with the denominator.** Every
   `pushTalkAudio` against an open session — accepted included — is noted into a
   `FailureCounters` under family `intercom-talk`, `variant` = the wire codec,
   and published through `failure-contribution` (D277). A push at a session the
   caller never opened is NOT counted: it moves the denominator without
   describing the camera.
5. **`IntercomStatus.ability` is written.** It was declared, mirrored into
   runtime state, and copied forward from `previous?.ability` at all four call
   sites by both providers while `session.sampleRate` and `session.audioCodec`
   were in hand and only reaching a log line. The session now owns an `ability`
   getter — the only party that knows its own codec and its **enforced** backlog
   — and both the raw-PCM and the WebRTC path write it.

## Consequences

- The catalogues are now nine entries and **must move together**. A codec in one
  and not the other is a call that works on the hub and refuses on the agent.
- `decoder-ffmpeg` gained `pcm_s16le` / `pcm_f32le` ENCODE mappings so its
  advertised surface is one it can actually serve; adding a catalogue row
  without the format map would turn a discovery answer into a runtime throw.
- `duplex: 'half'` is the one judgement in `ability`. Both firmwares expose a
  single talk channel and both providers enforce one active session per camera.
  `'full'` would be the dangerous direction — a consumer that believes it may
  listen while speaking takes no lock. `intercom.cap.ts:109`'s open question
  about a per-device lock is now answerable from data rather than assumption.
- The backlog clamp moved into one `clampBacklogMs` per session class, because
  `ability.maxBacklogMs` must report the bound the buffer HONOURS, not the one
  it was asked for.
- `TalkPcmTranscoder` and the counters exist **twice**, one copy per provider
  package. Addons never import each other and promoting the file to
  `@camstack/types` would put a two-provider helper on the framework publish
  train. Duplication is the accepted cost here (as it already is for
  `IntercomAudioCodecApi` and the two intercom orchestrators); DIVERGENCE is
  not, and is guarded.
- **No cap file changed**, so no `codegen`, and no framework publish train:
  this ships as two addon deploys (`provider-hikvision`, `provider-reolink`)
  plus whichever `audio-codec` provider is active on each node
  (`decoder-nodeav` / `decoder-ffmpeg`). Deploying the providers WITHOUT the
  decoder is the ordering that produces a refusal rather than a wrong-rate
  frame — which is the safe direction, and is why the refusal is named
  `pcm-resample-session-failed` rather than swallowed.
- Both provider manifests now declare `failure-contribution`.

## Enforcement

Two guards, both wired into `.github/workflows/ci.yml`:

- `scripts/check-audio-codec-catalog-parity.ts` — the two advertised catalogues <!-- drift-ok: deleted in D763 -->
  are identical (name, order, `canDecode`/`canEncode`); every ffmpeg entry has a
  format mapping it can serve; every nodeav entry has a `resolveCodecKey` case.
  All three branches were disarmed and confirmed red.
- `scripts/check-intercom-rate-refusal.ts` — neither camera file still carries
  the drop message, `startTalkSession` builds a transcoder, `endTalkSession`
  closes it, and the two copies of the transcoder are byte-identical. The camera
  files are 4 000 lines and constructing one needs the whole `DeviceContext`, so
  this seam is guarded structurally; everything the transcoder itself does is a
  real unit test asserting on the bytes that reach the transport.

Behaviour is covered by `talk-pcm-transcoder.spec.ts` in both packages (the fake
`audio-codec` returns bytes deliberately unlike its input, so a passthrough
regression fails on the transport assertion) and by
`packages/addon-decoder-nodeav/src/audio-codec/__tests__/roundtrip.spec.ts`,
which runs a real 22 050 → 8 000 Hz `pcm_s16le` conversion through libswresample
and asserts the output SAMPLE COUNT — an interval that excludes unconverted
22 050-rate output.
