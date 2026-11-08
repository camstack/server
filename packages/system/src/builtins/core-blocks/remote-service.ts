/**
 * The `remote` cap (D963, D964): a button panel over a media-player device. It
 * keeps the per-device configuration (layout template, role bindings, custom
 * buttons, power mode) in the device's settings store and runs a bound ROLE by
 * calling the action it is bound to — the shape an Action step has, so an
 * infrared code and a smart-TV call are the same thing here.
 *
 * Decisions that shape this file:
 *  - **What a button does is the action's business.** This service never
 *    knows what an infrared code is; it invokes a cap method on a device.
 *  - **`repeat` is the caller's** (volume ×5), never stored. It is N FULL
 *    sends, `REMOTE_REPEAT_GAP_MS` apart (the SmartIR / Home Assistant model: no
 *    protocol repeat frame, the caller re-sends). A failing send stops the row
 *    and reports the cause; it is never swallowed.
 *  - **Power truth** (`assumedStatus`): a `running-state` reading wins; else the
 *    linked plug — off is `off` (a reading), on is `standby` (assumed) until a
 *    power command is sent, then what the remote sent.
 *  - **State is read from the running-state cap if the device has one, else
 *    from a native media-player reading, else assumed.** An assumption moves
 *    only AFTER a send succeeded, is persisted per device and never recorded
 *    in history. A toggle power code is sent only when the current state
 *    differs from the requested one; a discrete pair is always sent. A mute on
 *    a device that does not report it is sent and marked assumed.
 *  - **Sources are declared** (planning#460). `availableSources` is the
 *    operator's declared sources, never the custom buttons. A source runs its
 *    steps in order under the device's lock (no other press interleaves),
 *    `stepDelayMs` apart; a refusal is typed (`unknown-source`,
 *    `unbound-step`, `undeclared-channel`) and a failed step stops the
 *    sequence and names itself. The source last sent is ASSUMED, and forgotten
 *    when the device is switched off, when the plug reads off and when a
 *    channel step moves the channel.
 *  - **Precedence** (`sendMediaCommand`): a media-player command takes the
 *    remote when its role is bound, else answers `not-routed` so the native
 *    cap runs. The dispatch redirect asks this for every caller.
 */
import {
  type CapCall,
  customKeyOfRole,
  EMPTY_REMOTE_ASSUMED_STATE,
  findChannelSource,
  type IRemoteProvider,
  type IScopedLogger,
  type MediaPlayerAssumedField,
  type MediaPlayerStatus,
  type RemoteAssumedState,
  type RemoteConfig,
  type RemoteMediaCommand,
  type RemoteSendResult,
  type RemoteSource,
  remoteSourceSteps,
  resolveRemoteSource,
} from '@camstack/types'

/** Per-device remote configuration, kept in the device's settings store. */
export interface RemoteConfigStore {
  read(deviceId: number): Promise<RemoteConfig>
  write(deviceId: number, config: RemoteConfig): Promise<void>
}

/** What the remote last sent and so guesses, kept in the device's settings store. */
export interface RemoteAssumptionStore {
  read(deviceId: number): Promise<RemoteAssumedState | null>
  write(deviceId: number, state: RemoteAssumedState): Promise<void>
}

/**
 * The device's `media-player` runtime slice, written through the standard
 * runtime-state path. The slice is a PROJECTION of `assumedStatus` — the one
 * computation `getStatus` is also answered from — so there is no second cache.
 */
export interface RemoteSliceWriter {
  /** The devices that carry a remote configuration. */
  devices(): Promise<readonly number[]>
  /** Writes the slice; a no-op when it already says the same. */
  publish(deviceId: number, status: MediaPlayerStatus): Promise<void>
}

export interface RemoteServiceDeps {
  readonly store: RemoteConfigStore
  readonly assumptions: RemoteAssumptionStore
  readonly slice: RemoteSliceWriter
  /**
   * Whether a driver's native media-player cap reads the device — the SAME
   * predicate the dispatch redirect uses. Such a device never gets an assumed slice.
   */
  hasNative(deviceId: number): boolean
  /** The device of the linked plug, or null when none is linked. */
  plugDeviceOf(deviceId: number): Promise<number | null>
  /** Runs the action a role is bound to. Throws when the call fails. */
  invoke(call: CapCall): Promise<void>
  templateExists(templateId: string): Promise<boolean>
  isMediaPlayer(deviceId: number): Promise<boolean>
  /** The native media-player slice, or null when no running source answers. */
  reportedStatus(deviceId: number): Promise<MediaPlayerStatus | null>
  /** The `running-state` reading, or null when the device has none or it is unknown (D393). */
  runningState(deviceId: number): Promise<boolean | null>
  /** The linked `power-source` switch: true on, false off, null when none is linked or it is unknown (D393). */
  plugOn(deviceId: number): Promise<boolean | null>
  readonly logger: IScopedLogger
  readonly now?: () => number
  /** Waits between two sends of a repeat; a spec drives it. */
  readonly sleep?: (ms: number) => Promise<void>
  /** How long one press (or one whole source) may run under the device lock. */
  readonly lockTimeoutMs?: number
}

/** A sequence is at most 16 steps of 3 s; a press that outlasts this is hung. */
export const REMOTE_LOCK_TIMEOUT_MS = 60_000

/** The pause between two full sends of a repeat — never stored, never a setting. */
export const REMOTE_REPEAT_GAP_MS = 150

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

type PowerState = 'on' | 'off'

const POWER_OFF_STATES: ReadonlySet<MediaPlayerStatus['state']> = new Set(['off', 'standby'])

/** Roles a media-player command tries, in order. The first BOUND one wins. */
function rolesFor(command: RemoteMediaCommand): readonly string[] {
  switch (command) {
    case 'play':
      return ['play', 'power_on']
    case 'stop':
      return ['stop', 'power_off']
    case 'pause':
      return ['pause']
    case 'next':
      return ['next']
    case 'previous':
      return ['previous']
    case 'setMute':
      return ['mute']
    case 'turnOn':
      return ['power_on']
    case 'turnOff':
      return ['power_off']
    case 'volumeUp':
      return ['volume_up']
    case 'volumeDown':
      return ['volume_down']
    case 'channelUp':
      return ['channel_up']
    case 'channelDown':
      return ['channel_down']
    case 'selectSource':
    case 'playMedia':
      return []
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class RemoteService implements IRemoteProvider {
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly lockTimeoutMs: number
  /** Remote devices seen so far, and the plug each one waits on: who an input event affects. */
  private readonly plugOf = new Map<number, number | null>()
  private readonly sliceRuns = new Map<number, Promise<void>>()
  private readonly slicePending = new Set<number>()
  /** The tail of each device's presses: a sequence is never interleaved with another press. */
  private readonly locks = new Map<number, Promise<void>>()

  constructor(private readonly deps: RemoteServiceDeps) {
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? realSleep
    this.lockTimeoutMs = deps.lockTimeoutMs ?? REMOTE_LOCK_TIMEOUT_MS
  }

  readonly getConfig: IRemoteProvider['getConfig'] = async ({ deviceId }) =>
    this.deps.store.read(deviceId)

  readonly setConfig: IRemoteProvider['setConfig'] = async ({ deviceId, config }) => {
    if (!(await this.deps.isMediaPlayer(deviceId))) {
      return {
        status: 'refused',
        reason: 'not-a-media-player',
        detail: `device ${deviceId} is not a media player`,
      }
    }
    if (
      config.layoutTemplateId !== null &&
      !(await this.deps.templateExists(config.layoutTemplateId))
    ) {
      return {
        status: 'refused',
        reason: 'unknown-template',
        detail: `no template "${config.layoutTemplateId}"`,
      }
    }
    await this.deps.store.write(deviceId, config)
    await this.refreshSlice(deviceId)
    return { status: 'saved' }
  }

  readonly listCommands: IRemoteProvider['listCommands'] = async ({ deviceId }) => {
    const config = await this.deps.store.read(deviceId)
    const commands = Object.keys(config.bindings).map((role) => {
      const key = customKeyOfRole(role)
      const label = key === null ? undefined : config.customButtons.find((b) => b.key === key)?.name
      return {
        role,
        ...(label === undefined ? {} : { label }),
        custom: key !== null,
      }
    })
    return {
      layoutTemplateId: config.layoutTemplateId,
      power: config.power,
      commands,
      sources: config.sources,
    }
  }

  readonly sendCommand: IRemoteProvider['sendCommand'] = async ({ deviceId, role, repeat }) => {
    const config = await this.deps.store.read(deviceId)
    return this.run(deviceId, config, role, repeat)
  }

  readonly sendMediaCommand: IRemoteProvider['sendMediaCommand'] = async (input) => {
    const { deviceId, repeat } = input
    const config = await this.deps.store.read(deviceId)
    if (input.command === 'selectSource') {
      return this.selectSource(deviceId, config, input.source)
    }
    if (input.command === 'playMedia') {
      return this.playMedia(deviceId, config, input.mediaType, input.mediaId)
    }
    const role = this.mediaRole(config, input)
    if (role === null) return { status: 'not-routed' }
    if (input.command === 'setMute' && input.muted !== undefined) {
      return this.setMute(deviceId, config, role, input.muted)
    }
    return this.run(deviceId, config, role, repeat)
  }

  /**
   * Writes the device's `media-player` slice from `assumedStatus`, but only
   * when the remote is what answers for it: a media player, no native source
   * (`hasNative`), and a power state the remote knows. Overlapping calls for a
   * device coalesce: one run in flight, one more pending. A failed write is
   * logged, never thrown — the next input change or send is the retry (D3).
   */
  refreshSlice(deviceId: number): Promise<void> {
    const running = this.sliceRuns.get(deviceId)
    if (running !== undefined) {
      this.slicePending.add(deviceId)
      return running
    }
    const run = this.drainSlice(deviceId).finally(() => {
      this.sliceRuns.delete(deviceId)
    })
    this.sliceRuns.set(deviceId, run)
    return run
  }

  private async drainSlice(deviceId: number): Promise<void> {
    do {
      this.slicePending.delete(deviceId)
      await this.writeSlice(deviceId)
    } while (this.slicePending.has(deviceId))
  }

  private async writeSlice(deviceId: number): Promise<void> {
    try {
      if (this.deps.hasNative(deviceId)) return
      if (!(await this.deps.isMediaPlayer(deviceId))) return
      this.plugOf.set(deviceId, await this.deps.plugDeviceOf(deviceId))
      const status = await this.statusOf(deviceId, false)
      if (status === null) return
      await this.deps.slice.publish(deviceId, status)
    } catch (err: unknown) {
      this.deps.logger.warn('remote: the media-player slice could not be written', {
        tags: { deviceId },
        meta: { error: errorText(err) },
      })
    }
  }

  /** Boot: every remote device. */
  async refreshSlices(): Promise<void> {
    for (const deviceId of await this.deps.slice.devices()) await this.refreshSlice(deviceId)
  }

  /**
   * A device's state changed: refresh the remote devices it feeds — the TV
   * itself (its running-state) and every TV whose linked plug it is. Any other
   * device costs no read.
   */
  async onInputChanged(deviceId: number): Promise<void> {
    const affected: number[] = []
    for (const [tv, plug] of this.plugOf) {
      if (tv === deviceId || plug === deviceId) affected.push(tv)
    }
    await Promise.all(affected.map((tv) => this.refreshSlice(tv)))
  }

  /**
   * What the remote ASSUMES (the last power and mute it sent), or null when it
   * knows neither. No plug, no running-state: that is `assumedStatus`.
   */
  readonly getAssumedStatus: IRemoteProvider['getAssumedStatus'] = async ({ deviceId }) => {
    const kept = await this.readAssumed(deviceId)
    if (kept.power === null && kept.muted === null && kept.source === null) return null
    const config = await this.deps.store.read(deviceId)
    const assumedFields: MediaPlayerAssumedField[] = []
    if (kept.power !== null) assumedFields.push('state')
    if (kept.muted !== null) assumedFields.push('isMuted')
    if (kept.source !== null) assumedFields.push('source')
    return this.buildStatus({
      state: kept.power?.state ?? 'standby',
      assumedFields,
      muted: kept.muted?.value ?? null,
      source: kept.source?.name ?? '',
      changedAt: Math.max(kept.power?.at ?? 0, kept.muted?.at ?? 0, kept.source?.at ?? 0),
      sources: config.sources,
    })
  }

  /**
   * The device's state as the remote knows it, or null when it knows no power
   * state. Power truth, in order: a `running-state` reading; the linked plug
   * (off is `off`, a reading; on is `standby` until a power command was sent,
   * then what the remote sent); the remote's own assumption. Mute comes from
   * the assumption, and only while the device may be on.
   */
  async assumedStatus(deviceId: number): Promise<MediaPlayerStatus | null> {
    return this.statusOf(deviceId, true)
  }

  /** `forget`: whether a plug that is off drops the kept power guess (a read's side effect). */
  private async statusOf(deviceId: number, forget: boolean): Promise<MediaPlayerStatus | null> {
    const kept = await this.readAssumed(deviceId)
    const truth = await this.powerTruth(deviceId, forget)
    if (truth === null) return null
    const assumedFields: MediaPlayerAssumedField[] = truth.assumed ? ['state'] : []
    const state = truth.state
    const changedAt = truth.at
    const mute = state === 'off' ? null : (kept.muted ?? null)
    if (mute !== null) assumedFields.push('isMuted')
    const source = state === 'off' ? null : (kept.source ?? null)
    if (source !== null) assumedFields.push('source')
    const config = await this.deps.store.read(deviceId)
    return this.buildStatus({
      state,
      assumedFields,
      muted: mute?.value ?? null,
      source: source?.name ?? '',
      changedAt: Math.max(changedAt, mute?.at ?? 0, source?.at ?? 0),
      sources: config.sources,
    })
  }

  private buildStatus(input: {
    readonly state: MediaPlayerStatus['state']
    readonly assumedFields: readonly MediaPlayerAssumedField[]
    readonly muted: boolean | null
    readonly source: string
    readonly changedAt: number
    readonly sources: readonly RemoteSource[]
  }): MediaPlayerStatus {
    return {
      state: input.state,
      stateSource: input.assumedFields.length > 0 ? 'assumed' : 'reported',
      assumedFields: [...input.assumedFields],
      volumeLevel: null,
      isMuted: input.muted,
      source: input.source,
      availableSources: input.sources.map((source) => source.name),
      declaredSources: input.sources.map((source) =>
        source.kind === 'digits'
          ? { name: source.name, kind: source.kind, number: source.number }
          : { name: source.name, kind: source.kind },
      ),
      currentMedia: null,
      position: null,
      duration: null,
      shuffle: null,
      repeat: null,
      positionUpdatedAt: null,
      lastChangedAt: input.changedAt,
    }
  }

  private mediaRole(
    config: RemoteConfig,
    input: { readonly command: RemoteMediaCommand },
  ): string | null {
    for (const role of rolesFor(input.command)) {
      if (this.isBound(config, role)) return role
    }
    return null
  }

  /** A role is reachable when bound, or when a toggle `power` stands for `power_on` / `power_off`. */
  private isBound(config: RemoteConfig, role: string): boolean {
    if (config.bindings[role] !== undefined) return true
    return (
      (role === 'power_on' || role === 'power_off') &&
      config.power.mode === 'toggle' &&
      config.bindings['power'] !== undefined
    )
  }

  private async currentState(deviceId: number): Promise<PowerState | null> {
    const running = await this.deps.runningState(deviceId)
    if (running !== null) return running ? 'on' : 'off'
    const reported = await this.deps.reportedStatus(deviceId)
    if (reported !== null) return POWER_OFF_STATES.has(reported.state) ? 'off' : 'on'
    const truth = await this.powerTruth(deviceId)
    if (truth === null || truth.state === 'standby') return null
    return truth.state === 'off' ? 'off' : 'on'
  }

  /**
   * THE ordered power truth, read by the status and by the toggle guard alike:
   * a `running-state` reading; the linked plug (off is `off`, a reading, and
   * it forgets what the remote assumed, so the next plug-on starts from
   * standby; on contradicts an assumed `off`, which is dropped); then the
   * remote's own assumption; a plug on with nothing sent is `standby`.
   */
  private async powerTruth(
    deviceId: number,
    forget = true,
  ): Promise<{
    readonly state: MediaPlayerStatus['state']
    readonly assumed: boolean
    readonly at: number
  } | null> {
    const running = await this.deps.runningState(deviceId)
    if (running !== null) return { state: running ? 'on' : 'off', assumed: false, at: this.now() }
    const plug = await this.deps.plugOn(deviceId)
    const kept = await this.readAssumed(deviceId)
    if (plug === false) {
      if (forget && (kept.power !== null || kept.source !== null)) {
        await this.deps.assumptions.write(deviceId, { ...kept, power: null, source: null })
      }
      return { state: 'off', assumed: false, at: this.now() }
    }
    const keptPower = plug === true && kept.power?.state === 'off' ? null : kept.power
    if (keptPower !== null) return { state: keptPower.state, assumed: true, at: keptPower.at }
    if (plug === true) return { state: 'standby', assumed: true, at: this.now() }
    return null
  }

  /** The mute as a native source reads it, else as last assumed, else unknown. */
  private async currentMute(deviceId: number): Promise<boolean | null> {
    const reported = await this.deps.reportedStatus(deviceId)
    if (reported !== null && reported.isMuted !== null) return reported.isMuted
    return (await this.readAssumed(deviceId)).muted?.value ?? null
  }

  private async readAssumed(deviceId: number): Promise<RemoteAssumedState> {
    return (await this.deps.assumptions.read(deviceId)) ?? EMPTY_REMOTE_ASSUMED_STATE
  }

  /**
   * `setMute(muted)`: skipped when the mute is already known to be that value;
   * otherwise the mute code is sent ONCE and the requested value is assumed —
   * including when the state was unknown, which is the only way it becomes known.
   */
  private async setMute(
    deviceId: number,
    config: RemoteConfig,
    role: string,
    muted: boolean,
  ): Promise<RemoteSendResult> {
    if ((await this.currentMute(deviceId)) === muted) {
      this.deps.logger.info('remote: mute skipped, the device is already in that state', {
        tags: { deviceId },
        meta: { muted },
      })
      return { status: 'skipped', reason: 'already-in-state' }
    }
    const result = await this.run(deviceId, config, role, 1)
    if (result.status === 'sent') {
      const kept = await this.readAssumed(deviceId)
      await this.deps.assumptions.write(deviceId, {
        ...kept,
        muted: { value: muted, at: this.now() },
      })
      await this.refreshSlice(deviceId)
    }
    return result
  }

  /**
   * Runs `fn` after every earlier press of the device has finished. A press that
   * does not finish within `lockTimeoutMs` is given up: the caller is told
   * (`press-timeout`) and the lock is released, so one hung press never wedges
   * the presses behind it.
   */
  private async withLock(
    deviceId: number,
    fn: () => Promise<RemoteSendResult>,
  ): Promise<RemoteSendResult> {
    const result = (this.locks.get(deviceId) ?? Promise.resolve()).then(() =>
      this.boundedPress(deviceId, fn),
    )
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.locks.set(deviceId, tail)
    try {
      return await result
    } finally {
      if (this.locks.get(deviceId) === tail) this.locks.delete(deviceId)
    }
  }

  private async boundedPress(
    deviceId: number,
    fn: () => Promise<RemoteSendResult>,
  ): Promise<RemoteSendResult> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.lockTimeoutMs)
    })
    const started = fn()
    try {
      const outcome = await Promise.race([started, expired])
      if (outcome !== 'timeout') return outcome
      started.catch(() => undefined)
      this.deps.logger.warn('remote: a press never finished, it was given up', {
        tags: { deviceId },
        meta: { timeoutMs: this.lockTimeoutMs },
      })
      return {
        status: 'refused',
        reason: 'press-timeout',
        detail: `the press did not finish within ${this.lockTimeoutMs} ms`,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  private run(
    deviceId: number,
    config: RemoteConfig,
    role: string,
    repeat: number,
  ): Promise<RemoteSendResult> {
    return this.withLock(deviceId, () => this.runRole(deviceId, config, role, repeat))
  }

  /**
   * `selectSource(name)`: the declared source a name (or its channel number)
   * points at. A remote that declares none leaves the call to the native cap.
   */
  private async selectSource(
    deviceId: number,
    config: RemoteConfig,
    wanted: string | undefined,
  ): Promise<RemoteSendResult | { readonly status: 'not-routed' }> {
    if (config.sources.length === 0) return { status: 'not-routed' }
    const source = wanted === undefined ? null : resolveRemoteSource(config.sources, wanted)
    if (source === null) {
      this.deps.logger.warn('remote: no declared source answers to that name, nothing was sent', {
        tags: { deviceId },
        meta: { wanted: wanted ?? null },
      })
      return {
        status: 'refused',
        reason: 'unknown-source',
        detail: `no source "${wanted ?? ''}" is declared`,
      }
    }
    return this.runSource(deviceId, config, source)
  }

  /** `playMedia` of a channel: the `digits` source that declares the number, else a refusal. */
  private async playMedia(
    deviceId: number,
    config: RemoteConfig,
    mediaType: string | undefined,
    mediaId: string | undefined,
  ): Promise<RemoteSendResult | { readonly status: 'not-routed' }> {
    if (mediaType !== 'channel' || config.sources.length === 0) return { status: 'not-routed' }
    const source = mediaId === undefined ? null : findChannelSource(config.sources, mediaId)
    if (source === null) {
      this.deps.logger.warn('remote: no source declares that channel, nothing was sent', {
        tags: { deviceId },
        meta: { channel: mediaId ?? null },
      })
      return {
        status: 'refused',
        reason: 'undeclared-channel',
        detail: `channel ${mediaId ?? ''} is not declared`,
      }
    }
    return this.runSource(deviceId, config, source)
  }

  /**
   * Presses a source's steps in order, one lock for the whole sequence,
   * `stepDelayMs` apart. Every step is checked bound BEFORE the first press, so
   * a half-bound source sends nothing. A step that fails stops the sequence.
   */
  private async runSource(
    deviceId: number,
    config: RemoteConfig,
    source: RemoteSource,
  ): Promise<RemoteSendResult> {
    const steps = remoteSourceSteps(source)
    const missing = steps.findIndex((role) => !this.isBound(config, role))
    if (missing >= 0) {
      const role = steps[missing] ?? ''
      this.deps.logger.warn('remote: a step of the source is not bound, nothing was sent', {
        tags: { deviceId },
        meta: { source: source.name, step: missing + 1, role },
      })
      return {
        status: 'refused',
        reason: 'unbound-step',
        detail: `step ${missing + 1}/${steps.length} (${role}) is not bound`,
        step: { index: missing + 1, role },
      }
    }
    return this.withLock(deviceId, async () => {
      for (const [at, role] of steps.entries()) {
        if (at > 0) await this.sleep(config.stepDelayMs)
        const result = await this.runRole(deviceId, config, role, 1)
        if (result.status === 'refused') {
          // The set already moved by the steps pressed: the old source no longer holds.
          if (at > 0) await this.forgetSource(deviceId)
          this.deps.logger.warn('remote: a step of the source failed, the sequence stopped', {
            tags: { deviceId },
            meta: { source: source.name, step: at + 1, role, reason: result.reason },
          })
          return {
            ...result,
            detail: `step ${at + 1}/${steps.length} (${role}): ${result.detail ?? result.reason}`,
            step: { index: at + 1, role },
          }
        }
      }
      const kept = await this.readAssumed(deviceId)
      await this.deps.assumptions.write(deviceId, {
        ...kept,
        source: { name: source.name, at: this.now() },
      })
      await this.refreshSlice(deviceId)
      return { status: 'sent', sends: steps.length }
    })
  }

  private async forgetSource(deviceId: number): Promise<void> {
    const kept = await this.readAssumed(deviceId)
    if (kept.source !== null) await this.deps.assumptions.write(deviceId, { ...kept, source: null })
  }

  private async runRole(
    deviceId: number,
    config: RemoteConfig,
    role: string,
    repeat: number,
  ): Promise<RemoteSendResult> {
    const wantsState: PowerState | null =
      role === 'power_on' ? 'on' : role === 'power_off' ? 'off' : null
    const viaToggle = wantsState !== null && config.bindings[role] === undefined
    const bound = viaToggle ? config.bindings['power'] : config.bindings[role]
    if (bound === undefined || (viaToggle && config.power.mode !== 'toggle')) {
      return {
        status: 'refused',
        reason: 'unbound-role',
        detail: `${role} is not bound`,
      }
    }
    if (viaToggle && (await this.currentState(deviceId)) === wantsState) {
      this.deps.logger.info('remote: power command skipped, the device is already in that state', {
        tags: { deviceId },
        meta: { role, state: wantsState },
      })
      return { status: 'skipped', reason: 'already-in-state' }
    }
    const times = wantsState === null && role !== 'power' ? repeat : 1
    for (let sent = 0; sent < times; sent += 1) {
      if (sent > 0) await this.sleep(REMOTE_REPEAT_GAP_MS)
      try {
        await this.deps.invoke({
          deviceId: bound.action.deviceId,
          cap: bound.action.cap,
          method: bound.action.method,
          args: bound.action.args ?? {},
        })
      } catch (err: unknown) {
        this.deps.logger.warn('remote: the bound action failed, nothing further was sent', {
          tags: { deviceId },
          meta: { role, sent, error: errorText(err) },
        })
        return {
          status: 'refused',
          reason: 'action-failed',
          detail: errorText(err),
        }
      }
    }
    await this.moveAssumption(deviceId, role, wantsState)
    await this.refreshSlice(deviceId)
    return { status: 'sent', sends: times }
  }

  /**
   * The assumption moves only after a send landed. A bare `power` flips a KNOWN
   * state; a bare `mute` press flips a KNOWN mute and leaves an unknown one
   * unknown (the press alone does not say which way it went).
   */
  private async moveAssumption(
    deviceId: number,
    role: string,
    wantsState: PowerState | null,
  ): Promise<void> {
    const kept = await this.readAssumed(deviceId)
    if (wantsState !== null) {
      await this.deps.assumptions.write(deviceId, {
        ...kept,
        power: { state: wantsState, at: this.now() },
        // Off forgets the source; on does not say which one the set woke on.
        source: wantsState === 'off' ? null : kept.source,
      })
      return
    }
    if (role === 'power') {
      const before = await this.currentState(deviceId)
      if (before === null) return
      const next: PowerState = before === 'on' ? 'off' : 'on'
      await this.deps.assumptions.write(deviceId, {
        ...kept,
        power: { state: next, at: this.now() },
        source: next === 'off' ? null : kept.source,
      })
      return
    }
    if (role === 'channel_up' || role === 'channel_down') {
      // The channel moved by an unknown amount: the declared source no longer holds.
      if (kept.source !== null)
        await this.deps.assumptions.write(deviceId, { ...kept, source: null })
      return
    }
    if (role === 'mute') {
      const before = await this.currentMute(deviceId)
      if (before === null) return
      await this.deps.assumptions.write(deviceId, {
        ...kept,
        muted: { value: !before, at: this.now() },
      })
    }
  }
}
