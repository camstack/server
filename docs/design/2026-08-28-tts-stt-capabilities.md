---
title: TTS and STT as capabilities — and the three format defects that must be fixed first
last-verified: 2026-08-28
covers:
  - packages/types/src/capabilities/llm.cap.ts
  - packages/types/src/capabilities/intercom.cap.ts
  - packages/addon-ai/**
---

# TTS and STT as capabilities

> **The ask.** Extend the LLM capability surface to speech synthesis and recognition, local and remote, so a camera can be spoken through (two-way audio) and listened to (spoken commands). Scope here: the cap design and its configuration UI. Not a wake word, not a grammar, not an assistant.

## 0 · Ship this first, on its own — it fixes a live defect ✅ LANDED (D281)

> **Stage 0 is done.** What follows is kept as the statement of the defect it
> fixed; the rule it settled is [D281](../decisions/adr-0281-a-talk-frame-at-the-wrong-rate-is-converted-by-the-codec-cap-or-refused-loudly.md).
> **No cap file changed, so no framework publish train** — it ships as two addon
> deploys plus the active `audio-codec` provider on each node.

**An `s16le` frame at the wrong sample rate was silently dropped, in both intercom providers, identically.**

`packages/addon-provider-hikvision/src/hikvision-camera.ts` and
`packages/addon-provider-reolink/src/reolink-camera.ts`:

> `intercom: s16le sampleRate mismatch (PCM-only resample not implemented) — dropping`

Hikvision talks at 8 kHz, Reolink typically 16 kHz, Piper emits 16 000 or 22 050. A naive TTS→intercom wiring produced **zero audible output on Hikvision** and worked by accident on Reolink.

**This was not a future problem.** HomeKit and Alexa raw-PCM talk-back went through the same branch, with one warn and no counter.

Two more defects behind it:

- **`audio-codec` could not resample PCM, by construction.** The catalogue (`packages/addon-decoder-nodeav/src/audio-codec/codec-catalog.ts:53`) had no linear-PCM entry, so the provider whose docblock says "transcode via the `audio-codec` cap" (`packages/types/src/capabilities/intercom.cap.ts:110`) **had nothing to call**. `pcm_s16le` / `pcm_f32le` are now entries in **both** providers of the singleton, and `scripts/check-audio-codec-catalog-parity.ts` keeps them in step. <!-- drift-ok: deleted in D763 -->
- **`IntercomAbility` was declared, mirrored into runtime state, and written by nobody.** `intercom.cap.ts:18` carries `{codecs, sampleRate, duplex, maxBacklogMs}`; both providers copied `previous?.ability ?? null` while the values were in hand. It is now written by the session that owns those facts (`packages/addon-provider-hikvision/src/intercom/hikvision-intercom-session.ts:190`, `packages/addon-provider-reolink/src/intercom-session.ts:143`), on both the raw-PCM and the WebRTC path. `duplex` is reported `half` on both — see D281 for why that is the safe direction.

**What landed** — linear PCM in both `audio-codec` catalogues; a lazy, keyed, torn-down-on-error `TalkPcmTranscoder` replacing the drop branch in each provider; `IntercomStatus.ability` written; and every `pushTalkAudio` outcome counted per camera through `failure-contribution` (D277), family `intercom-talk`, `variant` = the wire codec. A frame that genuinely cannot be converted is **still refused, loudly, with `tags: { deviceId }`, and nothing is fed** — the refusal discipline the original comment established is the thing that survives.

## 1 · One consumer cap, one internal runtime cap

Mirror `llm` / `llm-runtime` exactly. `llmCapability` (`packages/types/src/capabilities/llm.cap.ts:213`) is system/collection/hub-only; `llmRuntimeCapability` (`packages/types/src/capabilities/llm-runtime.cap.ts:181`) is `internal: true`, on every node, reached with `nodePin`.

TTS and STT are different shapes, but everything a second cap would duplicate is purpose-independent: profile store, secret discipline, defaults chain, usage rollup, derived form editor, managed-model install. `llm` already carries two disjoint purposes gated by one per-profile boolean, **refused never degraded** (`llm.cap.ts:51`). Transfer it:

    SpeechProfile.purposes: ('tts'|'stt')[]   // non-empty
    SpeechProfile.streamingStt: boolean

A `synthesize` against a profile without `'tts'` is `bad-request` naming the profile.

Methods: `synthesize`, `transcribe`, `openTranscription` / `pushAudio` / `pullTranscript` / `closeTranscription`, `cancel`, plus the whole `llm` operator surface cloned (profiles, defaults, usage, model catalogue, runtime status).

Binary rides `Uint8Array` — the sanctioned convention across superjson and the UDS MsgPack channel (`packages/types/src/capabilities/llm-shared.ts:58`). Bounds are **refused, not truncated**: `truncated: false` is a literal on the result type, because a half-spoken announcement is worse than none.

## 2 · TTS one-shot; STT both, and neither emulates the other

An announcement is 1–5 s = 32–160 KB at 16 kHz — the same order as the audio chunks the broker already ships inline. **TTS streams nothing.** Precedent: `llm.generate` is a plain mutation and LLM streaming rides a data plane (`packages/addon-ai/src/test-chat/plane.ts:1`), never a cap method.

STT needs both: one-shot must work over **stored** audio with no live session (D54), streaming must not buffer to completion. `streamingStt: false` + `openTranscription` = **`streaming-unsupported`, refused, never emulated** — buffering 30 s to fake a stream produces a "live" transcript the caller cannot tell from a working one.

Streaming is **subscribe/pull, not a tRPC subscription**: every cross-process audio plane here already is, and a WS push cannot be driven by an addon holding a `nodePin`. Session methods carry an optional `nodeId` for sticky routing (`packages/types/src/capabilities/audio-codec.cap.ts:128`).

## 3 · Format negotiation has three named owners

1. **`audio-codec` does the arithmetic.** ✅ `pcm_s16le`/`pcm_f32le` are in the catalogue in **both** providers of the singleton. A decode session `{pcm_s16le, 22050→8000, s16le}` is a pure libswresample pass through session-scoped, node-local, inventoried machinery. **No new resampler is written anywhere.** The "byte-for-byte in step" claim at `codec-catalog.ts:39` is now checked by `scripts/check-audio-codec-catalog-parity.ts`, which also refuses a catalogue entry the ffmpeg backend has no format mapping for. <!-- drift-ok: deleted in D763 -->
2. **The intercom provider decides it is needed.** ✅ `TalkPcmTranscoder` (`packages/addon-provider-hikvision/src/intercom/talk-pcm-transcoder.ts`, duplicated per package because addons never import each other) replaced both drop branches: lazy, keyed by source rate, torn down with the talk session and on error, exactly like the existing `opusDecode`. It owns the FEED, so bytes reach the camera only after the codec cap handed them back. The provider is the only party that knows the target; that knowledge leaking upward is what the cap docblock promises will not happen.
3. **The speech sink avoids paying for it.** `synthesize` takes `want: {sampleRate, channels, format}` so the engine picks a voice at the camera's native rate. Naming the owner is not the same as always paying: on the happy path the resample never runs.

**One place turns an utterance into frames:** `SpeakSink` — resolve via `getProviderForDevice` (never branch on `DeviceBindingEntry.kind`, D13) → `startTalkSession` → read ability → synthesize at that rate → 20 ms frames with a monotonic sequence → push **at real time** (both sessions clamp backlog; ADPCM smears on reorder) → `endTalkSession` always, including on throw. Guard it with a single-owner script, the way `deriveDetailCropRect` is guarded. Every line `tags: { deviceId }`.

## 4 · The operator model: provider once, per camera only "may it listen"

`AI → Speech` clones `AiProfilesTab.tsx:205` — a table with `Kind`, `Purposes`, `Voice/Model`, **`Data`** (egress badge), `Node`, `On`; `Add profile` → kind picker → form built from `listProfileKinds`. **No hand-written form.** Defaults card with three purpose selectors (`tts`, `stt`, `stt-streaming`), keeping both existing warnings (a default naming a missing profile; one naming a disabled profile).

One button proves the chain rather than the synthesiser: `speech.testSpeak({deviceId, text})` drives the real `SpeakSink`.

**The per-camera control is not a switch.** `camera-switches.ts:5` records that the aggregate group is being withdrawn (D113) and nothing new may be built on it. So it is a `speech-listen` **wrapper cap**, `defaultActive: false`, the `audio-analysis` archetype (`audio-analysis.cap.ts:27`), controlled by `deviceManager.setWrapperActive` — riding the existing wrapper-binding authority, so a camera not listening reports as **disabled, not broken**.

> ⚠️ **Trap to write into the cap file.** A `scope:'device'` + `singleton` + `wrapper` cap resolves through `getSingleton` at the mount and **never consults bindings**. `audio-analysis` survives only because its consumer reads the BINDING, not the provider. `speech-listen` must do the same, or it reproduces the D62 silent-knob bug.

**TTS gets no per-camera knob at all** — a camera either has an `intercom` provider bound or it does not, and `getProviderForDevice` already answers. A second store saying "speaking allowed here" is D62's exact failure.

## 5 · Local engines, no GPU assumed

**TTS — Piper.** Native binary child, voice 20–110 MB, ~120–200 MB transient RSS, 0.05–0.3× realtime on an N100, **no GPU**. Emits 16-bit PCM at the voice's native rate, so it lands directly on `s16le`. Italian voices exist. Process per utterance; holds nothing between announcements. Kokoro-82M ONNX is the later upgrade (better voice, 3× the memory); espeak-ng is the floor. **Coqui XTTS rejected** — 3–4 GB and unusable on CPU.

**STT — whisper.cpp `whisper-server`** for Stage 3: ggml `base.en` q5_1 ≈57 MB → ~250 MB RSS, 0.5–1× realtime. It reproduces `llm-runtime`'s supervisor shape verbatim (pinned ref + sha256, spawn flags, idle-stop, `ensureBinary`), so the install UI, the model distributor relay and the crash policy are **reused, not rebuilt**. Not genuinely streaming. **sherpa-onnx streaming Zipformer** is the Stage-4 answer (~300–500 MB, genuine streaming, onnxruntime already provisioned).

Combined: Piper ~150 MB transient + whisper `base.en` ~250 MB while listening, idle-stopped after. Fits beside `addon-ai` in the `ml` group on an 8–16 GB N100. **On a 4 GB agent it does not** — `idleStopMinutes` is the mechanism, not a hope. `rssBudgetMb` declared **only after measurement**; the guard refuses guesses.

## 6 · Remote providers: the decision is the pairing, not the provider

**Egress is a derived kind fact.** `dataEgress: 'local'|'lan'|'internet'`, fixed for named kinds and for `openai-compatible` **resolved from the base URL host by a pure function** (loopback / RFC1918 / `.lan` / `.local` → `lan`). Pure means testable and means a row cannot lie. `lan` is a real third state: collapsing it into `internet` would mislabel the commonest self-hosted setup.

**Consent is taken at the binding, with the camera named.** Enabling `speech-listen` resolves the STT default at that moment and states the consequence with both nouns in it — *"Cortile (102)'s microphone will be sent to OpenAI (internet) whenever this camera is listening."* That is `costWhenOff`'s discipline (`camera-switches.ts:248` — "a switch that cannot say what it costs should not ship") applied to a cost-when-**on**. Because a later change of the global default silently changes the pairing, the page carries a standing banner naming every camera whose listening now egresses.

**Usage is keyed on `deviceId`.** `LlmUsageRollupSchema` (`llm.cap.ts:133`) keys on `(day, consumer, profileId)` and cannot answer the only question anyone asks about audio. The speech rollup adds `deviceId` non-optional and `dataEgress`, so the headline reads: *"X minutes of audio from N cameras left this network in the last 30 days."*

A streaming remote session is an open socket carrying live household audio: `maxSessionSeconds` on the profile, refused rather than extended, and both open and close lines carry `deviceId`, `profileId`, `dataEgress`. A branch that silently *emits* work off-box deserves at least the logging a branch that drops work gets.

## 7 · Seams found vs. seams to build

**Found, usable as-is.** STT input is **already the right format**: `subscribeAudioChunks`/`pullAudioChunks` (`stream-broker.cap.ts:755`) deliver inline bytes, and every broker decode session targets **16 kHz mono** (`stream-broker.ts:4260` AAC, `:4272` Opus). **There is no conversion to design on the input side** — which is why STT is cheaper to land than TTS. Also reusable: the audio chunk poller, the wrapper-binding gate and `audioMode` schedule (`audio-subscription-controller.ts:620`), the on-motion window (`:434`), the window accumulator, and the entire LLM operator machinery.

**Built (Stage 0, D281).** PCM↔PCM in `audio-codec` (catalogue entries only); the transcode branch per intercom provider; `IntercomAbility` actually written.

**Still to build.** `SpeakSink` with its guard; the three caps plus `addon-speech` (`any-node`, group `ml`, engine **always** a supervised child process — that is what keeps the shared runner safe and the RSS honest); the `AI → Speech` page.

## 8 · Stages

- **Stage 0** ✅ **DONE (D281)** — format repairs. No new cap, no framework train. Ships alone and fixes HomeKit/Alexa talk-back today.
- **Stage 1** — TTS end to end, local, one-shot: the two caps, `addon-speech`, Piper, `SpeakSink`, the page, `testSpeak`. Acceptance: type a sentence, hear it from a Reolink **and** a Hikvision, no cloud account.
- **Stage 2** — remote providers + STT one-shot, with egress badges, binding-time consent copy and `deviceId`-keyed usage.
- **Stage 3** — local STT one-shot (whisper.cpp), `speech-listen` wrapper driven by the existing on-motion window.
- **Stage 4** — streaming STT (sherpa-onnx local, Deepgram/OpenAI realtime remote).

Out-of-scope constraints noted: a wake word needs partial hypotheses, so `final` exists on the hypothesis type from Stage 4's first line. A speaking notifier imposes exactly one: `synthesize` must be callable **with no device**, which is why no cap method takes a `deviceId` — only the sink does. And `IntercomAbility.duplex` exists and nothing reads it: a half-duplex camera cannot listen while speaking, so the sink and the listen controller need a per-device lock.

## 9 · What could not be determined

1. Whether the embedded portable Python has wheels for `sherpa-onnx` / `ctranslate2` on every target arch, **aarch64 in particular** — decides whether the Python route exists for Stage 4.
2. ~~Whether `decoder-ffmpeg`'s audio catalogue is literally identical to `decoder-nodeav`'s.~~ **ANSWERED.** The two ADVERTISED catalogues were identical — seven entries, same order, same flags. The ffmpeg addon's INTERNAL `DECODE_FORMAT_BY_CODEC` had already drifted into a superset (`pcm_s16be` / `pcm_s16le` entries the catalogue gate in `createDecodeSession` made unreachable), so the drift was latent rather than live and Stage 0 was NOT bigger than it looked. Both are now checked by a guard.
3. ~~Whether node-av's branded codec-id union exposes `AV_CODEC_ID_PCM_S16LE`.~~ **ANSWERED: yes.** `AV_CODEC_ID_PCM_S16LE` = 65536 and `AV_CODEC_ID_PCM_F32LE` = 65557 on the real `node-av/constants`; `resolveAvCodecId` needed two `case`s and no adapter. Asserted against the installed module in `nodeav-av-types.spec.ts`, not a stub.
4. ~~The Wyze provider's `pushTalkAudio`.~~ **ANSWERED, and deliberately NOT changed.** `wyze-camera.ts:361` has no drop branch to replace: it destructures `pushTalkAudio` **without `codec`** and forwards `sampleRate ?? backchannel.sampleRate` into `writeAudio`, which stamps the caller's rate into the frame header and writes the payload verbatim under the BACKCHANNEL's codec id. So the Wyze defect is the opposite shape — a mismatched **codec** accepted silently, on a hand-rolled DTLS backchannel the file marks experimental and gated. Whether the camera honours a per-frame rate cannot be established without hardware. Forcing the transcoder in would fix a rate problem Wyze may not have while leaving the codec problem it does have.
5. What a scheduled announcement does to an operator already talking, on battery cameras. Documented mutually exclusive (`intercom.cap.ts:96`) but the collision is unspecified — decides whether the sink queues or refuses.
6. Measured RSS for Piper and whisper.cpp on the real agent hardware. Required before any budget.
7. Whether the HF resolver generalises to non-GGUF artifacts (Piper's `.onnx` + `.json` pair, whisper's `.bin`).
8. Whether the Viewer is expected to trigger announcements — the auth tier on `testSpeak` must then be decided against the access map rather than defaulted, and that default is the documented trap.
