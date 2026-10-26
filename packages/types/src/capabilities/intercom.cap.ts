import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'

/**
 * Two-way audio / talk-back cap. Clients open a WebRTC audio-only
 * session (server-initiated offer pattern, identical to the main
 * video WebRTC flow) and the browser captures the mic; the server
 * receives Opus RTP via werift, decodes through ffmpeg, re-encodes
 * to the firmware's expected codec (Reolink: IMA ADPCM), and pipes
 * it onto the camera's dedicated talk channel.
 *
 * All audio transcoding happens server-side — clients don't need to
 * know the camera's wire format. The `ability` cached in `status`
 * exposes the firmware's codec/sampleRate only for display/debug;
 * the client never has to act on those values.
 */
export const IntercomAbilitySchema = z.object({
  /** Codecs accepted by firmware, in preference order. Driver-authored strings. */
  codecs: z.array(z.string()),
  /** Sample rate (Hz) the firmware expects. Reolink typical: 16000. */
  sampleRate: z.number().meta(readingMeta('none')),
  duplex: z.enum(['half', 'full']),
  /** Max in-flight audio backlog before drop (ms). Server uses this to bound latency. */
  maxBacklogMs: z.number().meta(readingMeta('duration-ms')),
})

export type IntercomAbility = z.infer<typeof IntercomAbilitySchema>

export const IntercomStatusSchema = z.object({
  /** True while a talk session is open. */
  talking: z.boolean(),
  /** Ms epoch of the most recent session start. Null if never opened. */
  lastSessionAt: z.number().nullable(),
  /** Firmware ability cached at first session creation. Null until probed. */
  ability: IntercomAbilitySchema.nullable(),
})

export type IntercomStatus = z.infer<typeof IntercomStatusSchema>

/**
 * Wire codec of a `pushTalkAudio` payload. The cap is codec-agnostic: the
 * caller declares (or omits) the wire format; the provider decides whether
 * to passthrough to the camera's native channel, transcode via the
 * `audio-codec` cap, or reject the call.
 *
 * - `opus`: encoded Opus access unit (one frame per call). `sampleRate`
 *   tags the encoder rate (HAP-style: 48000 for iOS, 16000/24000 for LTE).
 * - `s16le`: raw little-endian signed 16-bit PCM, mono unless `channels`
 *   says otherwise. `sampleRate` is REQUIRED.
 * - `g711ulaw` / `g711alaw`: 8 kHz mono G.711 (µ-law / A-law). `sampleRate`
 *   is implied 8000 — set explicitly for clarity in logs.
 *
 * When `codec` is omitted the provider falls back to its native default
 * (the format the camera-side encoder consumes natively). That default
 * is "s16le @ provider-native sampleRate, mono" — Hikvision: 8000 Hz,
 * Reolink: per-talk-session rate (16000 Hz typical).
 */
export const TalkAudioCodecSchema = z.enum(['opus', 's16le', 'g711ulaw', 'g711alaw'])

export type TalkAudioCodec = z.infer<typeof TalkAudioCodecSchema>

export const intercomCapability = {
  name: 'intercom',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Camera],
  /**
   * **Auth tier: `protected` on every method — deliberate, and load-bearing.**
   *
   * Talking through a camera is an OPERATE action, not a CONFIGURE one. This
   * cap has no configuration surface at all: all six methods open, feed and
   * close one live audio session against one `deviceId`. That is the same
   * authority as `ptz.move` or `snapshot.getSnapshot`, both `protected` — and
   * the opposite of `ptz.savePreset` / `snapshot.invalidateCache`, which are
   * `admin` because they change what the device IS.
   *
   * `protected` does not mean ungated: `protectedProcedure` runs the
   * `METHOD_ACCESS_MAP` scope check, and every method here is `scope: 'device'`
   * with `access: 'create'` and a `deviceId` in its input. So a caller needs a
   * grant that covers THAT camera at `create` — a `camera-viewer` (`view`
   * only) still cannot talk, and a grant on camera 5 cannot talk through
   * camera 7.
   *
   * Every method was `auth: 'admin'` from the initial commit, which made the
   * cap unreachable by every non-admin principal — `adminProcedure` throws
   * `FORBIDDEN: Admin required` BEFORE the scope check runs, so the scope
   * machinery generated for this cap (`METHOD_ACCESS_MAP`,
   * `DEVICE_SCOPED_CAPS`, `METHOD_DEVICE_SELECTORS`) was complete and dead. The
   * `camera-operator` scope preset has promised "PTZ control, intercom,
   * snapshots" since that same commit; the promise could not be kept. Recorded
   * as D289; `scripts/check-scope-preset-promises.ts` now fails the build if a
   * preset promises a cap no row of that preset can reach.
   */
  methods: {
    /**
     * Open a server-side WebRTC audio-only session. Returns an SDP
     * offer with a single sendonly audio m-line the client answers
     * (client → server direction). The server wakes battery cams
     * transparently before opening the upstream talk channel.
     */
    startSession: method(
      z.object({ deviceId: z.number() }),
      z.object({ sessionId: z.string(), sdpOffer: z.string() }),
      { kind: 'mutation', auth: 'protected' },
    ),
    handleAnswer: method(
      z.object({
        deviceId: z.number(),
        sessionId: z.string(),
        sdpAnswer: z.string(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
    /** Close explicitly. Server also auto-closes on 30s idle. */
    stopSession: method(z.object({ deviceId: z.number(), sessionId: z.string() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    /**
     * Open a raw-PCM talk session (no WebRTC SDP plumbing). Used by
     * non-WebRTC consumers (HomeKit export, Alexa raw audio, test
     * harnesses) that already have decoded PCM frames and just need a
     * direct path onto the camera's talk channel. Mutually exclusive
     * with `startSession` (an active WebRTC session must be stopped
     * before a raw-PCM session can be opened on the same device, and
     * vice versa).
     */
    startTalkSession: method(
      z.object({ deviceId: z.number() }),
      z.object({ sessionId: z.string() }),
      { kind: 'mutation', auth: 'protected' },
    ),
    /**
     * Push one chunk of talk-back audio onto the active talk session.
     * The cap is codec-agnostic: the caller declares (or omits) the
     * wire format via `codec`; the provider decides between passthrough
     * (when the wire codec matches the camera's native talk channel),
     * transcoding via the `audio-codec` cap, or rejecting the call.
     *
     * Callers do NOT need to know the camera's wire format or sample
     * rate — that information lives entirely inside the provider.
     *
     * Sequence numbers MUST be monotonic per talk session; older frames
     * arriving after newer ones are dropped to avoid smearing the
     * downstream encoder state (G.711 is stateless but IMA ADPCM's
     * predictor would corrupt with re-ordering).
     */
    pushTalkAudio: method(
      z.object({
        deviceId: z.number(),
        /** Audio bytes for ONE frame, base64-encoded so the payload
         *  survives tRPC JSON serialization. */
        audioBase64: z.string(),
        /** Wire codec of the payload. Omit to let the provider default
         *  to its native expected format (s16le @ provider-native rate,
         *  mono). See {@link TalkAudioCodecSchema} for the supported set. */
        codec: TalkAudioCodecSchema.optional(),
        /** Sample rate (Hz). REQUIRED for `s16le`; advisory for
         *  `opus` (encoder clock); ignored for `g711*` (implied 8000). */
        sampleRate: z.number().int().positive().optional(),
        /** Channel count. Default 1. */
        channels: z.number().int().positive().optional(),
        /** Sequence number for ordering / dropping out-of-order frames. */
        sequenceNumber: z.number().int(),
      }),
      z.object({ accepted: z.boolean() }),
      { kind: 'mutation', auth: 'protected' },
    ),
    /** Close the raw-PCM talk session. Idempotent. */
    endTalkSession: method(z.object({ deviceId: z.number() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
  },
  events: {
    onStatusChanged: {
      data: z.object({
        deviceId: z.number(),
        status: IntercomStatusSchema,
      }),
    },
  },
  status: {
    schema: IntercomStatusSchema,
    kind: 'command-driven',
  },

  /**
   * Runtime-state slice — mirrored by the kernel.
   *
   * The cap declared `status` and nothing else, so the only two sources an
   * exporter has for a value — the `device.state-changed` slice event and the
   * `deviceState.getAllSnapshots` snapshot, both built from runtime state —
   * carried nothing for `intercom`. A talk-back entity in Home Assistant would
   * have been published and never received a value, which is the defect the
   * export's two classification tables exist to prevent (177 of them, once), so
   * `intercom` was excluded rather than exported.
   *
   * The shape is the status shape: there is exactly one truth about talk-back
   * and duplicating it into a second schema is how two halves of one capability
   * come to disagree. Providers write it through
   * `this.runtimeState.setCapState('intercom', …)` at the four points that open
   * and close a session, and seed it at registration so the slice exists before
   * the first session rather than after it.
   *
   * **Bound, named rather than hidden:** `talking` mirrors the provider's own
   * session handle, so a session torn down by a transport death that never
   * reaches `stopSession` / `endTalkSession` leaves it latched until the next
   * session or the next restart. That is why the slice is `session` and not
   * `restored` — a restart must never restore "talking".
   */
  runtimeState: IntercomStatusSchema,

  /**
   * Runtime-state durability: **session** — `talking` describes a live audio
   * session, which by definition does not survive the process that held it.
   * Restoring it would publish a camera as talking to nobody.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /**
   * History (D850): none — talk sessions are a ledger concern, not a trend.
   */
  history: 'none',
} as const satisfies CapabilityDefinition

export type IIntercomProvider = InferProvider<typeof intercomCapability>
