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
 *  - **`repeat` is the caller's** (volume ×5), never stored. A failing send
 *    stops the row and reports the cause; it is never swallowed.
 *  - **State is read from the running-state cap if the device has one, else
 *    from a native media-player reading, else assumed.** An assumption moves
 *    only AFTER a send succeeded, is persisted per device and never recorded
 *    in history. A toggle power code is sent only when the current state
 *    differs from the requested one; a discrete pair is always sent. A mute on
 *    a device that does not report it is sent and marked assumed.
 *  - **Precedence** (`sendMediaCommand`): a media-player command takes the
 *    remote when its role is bound, else answers `not-routed` so the native
 *    cap runs. The dispatch redirect asks this for every caller.
 */
import {
  type CapCall,
  customKeyOfRole,
  customRole,
  EMPTY_REMOTE_ASSUMED_STATE,
  type IRemoteProvider,
  type IScopedLogger,
  type MediaPlayerAssumedField,
  type MediaPlayerStatus,
  type RemoteAssumedState,
  type RemoteConfig,
  type RemoteMediaCommand,
  type RemoteSendResult,
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

export interface RemoteServiceDeps {
  readonly store: RemoteConfigStore
  readonly assumptions: RemoteAssumptionStore
  /** Runs the action a role is bound to. Throws when the call fails. */
  invoke(call: CapCall): Promise<void>
  templateExists(templateId: string): Promise<boolean>
  isMediaPlayer(deviceId: number): Promise<boolean>
  /** The native media-player slice, or null when no running source answers. */
  reportedStatus(deviceId: number): Promise<MediaPlayerStatus | null>
  /** The `running-state` reading, or null when the device has none or it is unknown (D393). */
  runningState(deviceId: number): Promise<boolean | null>
  readonly logger: IScopedLogger
  readonly now?: () => number
}

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
    case 'selectSource':
      return []
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class RemoteService implements IRemoteProvider {
  private readonly now: () => number

  constructor(private readonly deps: RemoteServiceDeps) {
    this.now = deps.now ?? Date.now
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
    return { layoutTemplateId: config.layoutTemplateId, power: config.power, commands }
  }

  readonly sendCommand: IRemoteProvider['sendCommand'] = async ({ deviceId, role, repeat }) => {
    const config = await this.deps.store.read(deviceId)
    return this.run(deviceId, config, role, repeat)
  }

  readonly sendMediaCommand: IRemoteProvider['sendMediaCommand'] = async (input) => {
    const { deviceId, repeat } = input
    const config = await this.deps.store.read(deviceId)
    const role = this.mediaRole(config, input)
    if (role === null) return { status: 'not-routed' }
    if (input.command === 'setMute' && input.muted !== undefined) {
      return this.setMute(deviceId, config, role, input.muted)
    }
    return this.run(deviceId, config, role, repeat)
  }

  /**
   * The device's state as the remote knows it, or null when it knows no power
   * state (nothing reads one and nothing was sent). The media-player
   * `getStatus` hook asks the native source FIRST and serves this only when
   * none answers. Power comes from the running-state cap when there is one,
   * else from the assumption; mute comes from the assumption.
   */
  async assumedStatus(deviceId: number): Promise<MediaPlayerStatus | null> {
    const kept = (await this.deps.assumptions.read(deviceId)) ?? EMPTY_REMOTE_ASSUMED_STATE
    const running = await this.deps.runningState(deviceId)
    const assumedFields: MediaPlayerAssumedField[] = []
    let state: PowerState
    let changedAt: number
    if (running !== null) {
      state = running ? 'on' : 'off'
      changedAt = this.now()
    } else if (kept.power !== null) {
      state = kept.power.state
      changedAt = kept.power.at
      assumedFields.push('state')
    } else {
      return null
    }
    if (kept.muted !== null) assumedFields.push('isMuted')
    const config = await this.deps.store.read(deviceId)
    return {
      state,
      stateSource: assumedFields.length > 0 ? 'assumed' : 'reported',
      assumedFields,
      volumeLevel: null,
      isMuted: kept.muted?.value ?? null,
      source: '',
      availableSources: config.customButtons.map((b) => b.name),
      currentMedia: null,
      position: null,
      duration: null,
      shuffle: null,
      repeat: null,
      lastChangedAt: Math.max(changedAt, kept.muted?.at ?? 0),
    }
  }

  private mediaRole(
    config: RemoteConfig,
    input: { readonly command: RemoteMediaCommand; readonly source?: string | undefined },
  ): string | null {
    if (input.command === 'selectSource') {
      const wanted = input.source
      const button = config.customButtons.find((b) => b.name === wanted || b.key === wanted)
      if (button === undefined) return null
      const role = customRole(button.key)
      return config.bindings[role] === undefined ? null : role
    }
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
    return (await this.readAssumed(deviceId)).power?.state ?? null
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
    }
    return result
  }

  private async run(
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
      return { status: 'refused', reason: 'unbound-role', detail: `${role} is not bound` }
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
        return { status: 'refused', reason: 'action-failed', detail: errorText(err) }
      }
    }
    await this.moveAssumption(deviceId, role, wantsState)
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
      })
      return
    }
    if (role === 'power') {
      const before = await this.currentState(deviceId)
      if (before === null) return
      await this.deps.assumptions.write(deviceId, {
        ...kept,
        power: { state: before === 'on' ? 'off' : 'on', at: this.now() },
      })
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
