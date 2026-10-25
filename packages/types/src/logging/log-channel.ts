/**
 * Per-component log CHANNELS — the gate a hot path consults, and the registry
 * an addon declares its channels in.
 *
 * ## Two axes, deliberately separated
 *
 * - **DECLARATION** — which channels exist. Only the addon knows:
 *   `stream-broker` knows webrtc/ICE/RTP, `provider-reolink` knows
 *   baichuan/handshake. A hand-wired central list rots at the first addition,
 *   and rots silently. So a channel is declared where it is consulted, and the
 *   `log-channels` capability enumerates the declarations.
 * - **VALUE** — at which level, for which scope, until when. That stays ONE
 *   thing: the logging settings document on the `system` cap. Two authorities
 *   over the values is the exact defect
 *   `docs/design/plans/2026-08-26-per-component-logging.md` was written to
 *   remove; re-introducing it from the cure side would be grotesque.
 *
 * Nothing in this file reads a clock, an env var or a store. The registry is
 * a MIRROR: it is moved only by {@link LogChannelRegistry.apply}, called off
 * the hot path with a value somebody actually read, and by
 * {@link LogChannelRegistry.tick}, called on a timer. A store read that fails
 * never reaches here, so it can neither disarm an armed channel nor arm a
 * disarmed one (D49).
 *
 * ## The canonical call shape
 *
 * ```ts
 * if (CH_RTP.on && CH_RTP.wants(deviceId)) {
 *   CH_RTP.log(logger, 'rtp subscriber added', { tags: { deviceId }, meta: { ssrc } })
 * }
 * ```
 *
 * `on` is a plain boolean FIELD — never a getter — and it is the FIRST thing
 * read. Disarmed, a call site costs one load and one branch, and the `extras`
 * object literal is never constructed because it lives inside the branch. It
 * is the same shape already proven in production at `stream-broker.ts:1650`,
 * and the same discipline `LoggingGate.allowsDestination` uses for the
 * destination floor (measured at 1.93 ns/call when off).
 *
 * ## Why a channel emits at `info`
 *
 * `loki-logging.addon.ts` pins the destination default at `info` and
 * `loki-destination.ts` drops everything below it, so a line emitted at
 * `debug` never reaches Loki and the hub's in-memory ring only holds ~35
 * minutes. A diagnostic that cannot be read an hour later is worse than no
 * diagnostic, because it looks done. {@link LogChannelGate.log} therefore
 * emits at the channel's declared level, whose schema floor is `info`.
 */

import { z } from 'zod'
import type { IScopedLogger, LogExtras, LogTags } from '../interfaces/logging.js'

/**
 * The level a channel writes at once armed.
 *
 * `debug` is absent ON PURPOSE and not by omission: below `info` the line does
 * not leave the process for Loki, and the whole point of arming a channel is
 * to read it later.
 */
export const LogChannelLevelSchema = z.enum(['info', 'warn', 'error'])

/**
 * What an addon declares about one channel. No value, no state — a
 * declaration is inert.
 */
export const LogChannelDescriptorSchema = z.object({
  /**
   * Dotted `area.thing`, unique across the workspace. `area` is conventionally
   * the addon's short name so an operator reading a channel list can tell who
   * owns it without a second lookup.
   */
  name: z
    .string()
    .min(3)
    .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'a channel name is dotted lower-kebab, e.g. area.thing'),
  /** One sentence: what the operator will SEE after arming it. */
  description: z.string().min(1),
  /** The level its lines are emitted at. Never below `info`. */
  defaultLevel: LogChannelLevelSchema,
  /**
   * Whether this channel can be narrowed to a camera.
   *
   * `true` is a PROMISE with two halves, and both must hold: the gate is
   * consulted with the numeric device id, AND every line the channel admits
   * carries `tags: { deviceId }` with that same numeric id. The second half is
   * what makes `| json | deviceId="102"` work in Loki — `loki-payload.ts`
   * keeps `deviceId` out of the stream labels for cardinality, so the tag in
   * the body is the only way to filter.
   *
   * A channel whose lines carry the device only in `meta` (or not at all) is
   * declared `false`. Declaring it `true` anyway would be a lie the UI repeats:
   * the operator narrows to one camera, sees nothing, and concludes the code
   * path was never taken.
   */
  perDevice: z.boolean(),
})

export type LogChannelDescriptor = z.infer<typeof LogChannelDescriptorSchema>

/**
 * An armed window over one channel, as the document hands it to a mirror.
 *
 * A window is a DEADLINE, never a flag (ADR-0244): a channel somebody forgot
 * expires by itself, which is the one failure a boolean cannot avoid.
 */
export const LogChannelWindowSchema = z.object({
  channel: z.string().min(1),
  /** Epoch ms the window closes at. */
  armedUntilMs: z.number(),
  /** `null` = every camera. A non-empty list narrows to those numeric ids. */
  deviceIds: z.array(z.number().int()).readonly().nullable(),
})

export type LogChannelWindow = z.infer<typeof LogChannelWindowSchema>

/**
 * The gate a hot path holds.
 *
 * Obtain it ONCE — at module scope or in a constructor — and keep the
 * reference. Looking a channel up by name per line would put a Map lookup on
 * the path this class exists to keep free.
 */
export class LogChannelGate {
  /**
   * HOT PATH GUARD. A plain data FIELD, and it must stay one.
   *
   * `log-channel.spec.ts` asserts the property descriptor has no getter and
   * booby-traps the device set, so turning this into an accessor — or reading
   * anything before it — fails the spec instead of taxing every line the
   * process emits.
   */
  on = false

  /** `null` while armed for every camera. Never read while `on` is false. */
  private devices: ReadonlySet<number> | null = null

  private level: LogChannelDescriptor['defaultLevel']

  private closesAtMs = 0

  constructor(readonly descriptor: LogChannelDescriptor) {
    this.level = descriptor.defaultLevel
  }

  /** Epoch ms this channel disarms itself at. 0 when disarmed. */
  get armedUntilMs(): number {
    return this.on ? this.closesAtMs : 0
  }

  /**
   * Does this channel want a line about `deviceId`?
   *
   * Call it only behind `gate.on &&`. On its own it is still correct — the
   * guard is repeated inside — but the point of the prefix is that a disarmed
   * channel must not pay the call at all.
   */
  wants(deviceId: number): boolean {
    if (!this.on) return false
    return this.devices === null || this.devices.has(deviceId)
  }

  /**
   * Emit one line on this channel, at the channel's declared level.
   *
   * The channel name is added as `tags.logChannel` so LogQL can select the
   * channel without matching on the message text, and whatever `tags` the
   * caller passed — `deviceId` above all — is preserved.
   */
  log(logger: IScopedLogger, message: string, extras: LogExtras): void {
    if (!this.on) return
    const tags: LogTags = { ...extras.tags, logChannel: this.descriptor.name }
    const line: LogExtras = { ...extras, tags }
    if (this.level === 'error') logger.error(message, line)
    else if (this.level === 'warn') logger.warn(message, line)
    else logger.info(message, line)
  }

  /**
   * Arm (or RE-arm, restarting) this channel. Off the hot path only.
   *
   * An empty `deviceIds` list is treated as "every camera" rather than "no
   * camera": a window that matches nothing is indistinguishable from a
   * disarmed one, and the operator who asked for it would wait for lines that
   * can never come.
   */
  arm(window: LogChannelWindow): void {
    const ids = window.deviceIds
    this.devices = ids === null || ids.length === 0 ? null : new Set(ids)
    this.closesAtMs = window.armedUntilMs
    this.on = true
  }

  /** Disarm. Off the hot path only. */
  disarm(): void {
    this.on = false
    this.devices = null
    this.closesAtMs = 0
  }
}

/**
 * Every channel this PROCESS declares, and the mirror of what is armed on it.
 *
 * One per process. A forked runner has its own, and it is refreshed through
 * the `log-channels` capability by the hub that owns the document — the
 * registry never reaches for a value itself.
 */
export class LogChannelRegistry {
  private readonly gates = new Map<string, LogChannelGate>()

  /**
   * Declare a channel and get its gate.
   *
   * A duplicate name throws. Two declarations of one name is a programming
   * error, not a merge: the operator would arm one and the other would stay
   * dark, which is the dead-knob shape (D62) with an extra step.
   */
  declare(descriptor: LogChannelDescriptor): LogChannelGate {
    const parsed = LogChannelDescriptorSchema.parse(descriptor)
    const existing = this.gates.get(parsed.name)
    if (existing !== undefined) {
      throw new Error(
        `log channel "${parsed.name}" is already declared in this process — ` +
          'two declarations of one name is a programming error, not a merge',
      )
    }
    const gate = new LogChannelGate(parsed)
    this.gates.set(parsed.name, gate)
    return gate
  }

  /** The declarations, sorted by name so a list is stable to read and diff. */
  list(): readonly LogChannelDescriptor[] {
    return [...this.gates.values()]
      .map((gate) => gate.descriptor)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** The gate for a declared channel, or `undefined`. */
  gate(name: string): LogChannelGate | undefined {
    return this.gates.get(name)
  }

  /**
   * Apply the FULL set of armed windows. Off the hot path.
   *
   * Full, not incremental, and that is the whole design: the document is the
   * authority, so a channel the document does not name is disarmed here. An
   * incremental apply would let a disarm get lost in transit and leave a
   * channel running that nobody can see is running.
   *
   * A window already past its deadline is ignored rather than armed — a
   * restore that re-armed an expired window would make a forgotten diagnostic
   * immortal across restarts.
   *
   * Returns the names it could not place, so the caller can log them: a
   * channel named in the document that this process does not declare is
   * either a typo or an addon that has not booted yet, and both deserve a
   * line rather than silence.
   */
  apply(windows: readonly LogChannelWindow[], nowMs: number): readonly string[] {
    const wanted = new Map<string, LogChannelWindow>()
    const unknown: string[] = []
    for (const window of windows) {
      if (window.armedUntilMs <= nowMs) continue
      if (!this.gates.has(window.channel)) {
        unknown.push(window.channel)
        continue
      }
      wanted.set(window.channel, window)
    }
    for (const [name, gate] of this.gates) {
      const window = wanted.get(name)
      if (window === undefined) gate.disarm()
      else gate.arm(window)
    }
    return unknown
  }

  /**
   * Disarm whatever has run out. Called on a timer, NEVER from a log path — a
   * diagnostic that adds a `Date.now()` to the path it is measuring measures
   * itself.
   *
   * Returns the names it closed, so the caller can write the one line that
   * says a window ended and stops "it went quiet" from reading as "the branch
   * was not taken".
   */
  tick(nowMs: number): readonly string[] {
    const closed: string[] = []
    for (const [name, gate] of this.gates) {
      if (gate.on && gate.armedUntilMs <= nowMs) {
        gate.disarm()
        closed.push(name)
      }
    }
    return closed
  }

  /** The channels armed right now, as the document would describe them. */
  armed(): readonly LogChannelWindow[] {
    const out: LogChannelWindow[] = []
    for (const [name, gate] of this.gates) {
      if (gate.on) out.push({ channel: name, armedUntilMs: gate.armedUntilMs, deviceIds: null })
    }
    return out
  }
}
