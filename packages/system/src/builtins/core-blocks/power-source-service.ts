/**
 * The `power-source` provider of core-blocks: a device that hangs is powered by
 * a smart switch the operator linked in Customize, and this cuts and restores
 * that power on demand.
 *
 * MANUAL ONLY. Nothing here decides to restart a device; every action is a call
 * from an admin. It is separate from the native `reboot` cap and neither
 * replaces nor wraps it.
 *
 * The link and the off time are read from the STORED composition on each call
 * (D676), never cached as a second copy. A forced restart is switch off now,
 * switch on after `offSeconds`, through an injected scheduler so a spec drives
 * the clock; the pending switch-on is cancelled on `stop()`.
 *
 * Every refusal is a typed result with its reason, logged with the device tag.
 */
import {
  type CompositionSourceRef,
  type CoreBlock,
  coreBlockComposition,
  type IPowerSourceProvider,
  type IScopedLogger,
  type PowerSourceActionResult,
  type PowerSourceInfo,
  type PowerSourceLink,
  type PowerSourceRefusalReason,
  powerSourceLinkOfComposition,
} from '@camstack/types'

/** What the service needs to know about a device it names. */
export interface PowerSourceDevice {
  readonly id: number
  readonly name: string
  readonly online: boolean
}

export interface PowerSourceDevices {
  /** The device for a source ref, or null when it cannot be found. */
  readonly find: (ref: CompositionSourceRef) => Promise<PowerSourceDevice | null>
  /** The switch's on/off state, or null when it has none. Throws when it cannot be read. */
  readonly readOn: (switchDeviceId: number) => Promise<boolean | null>
  readonly setOn: (switchDeviceId: number, on: boolean) => Promise<void>
}

export interface PowerSourceTimer {
  readonly cancel: () => void
}

export interface PowerSourceScheduler {
  readonly schedule: (delayMs: number, fire: () => void) => PowerSourceTimer
}

export const timeoutScheduler: PowerSourceScheduler = {
  schedule: (delayMs, fire) => {
    const handle = setTimeout(fire, delayMs)
    return { cancel: () => clearTimeout(handle) }
  },
}

export interface PowerSourceServiceDeps {
  readonly blocks: () => readonly Pick<CoreBlock, 'source'>[]
  readonly devices: PowerSourceDevices
  readonly scheduler: PowerSourceScheduler
  readonly logger: IScopedLogger
}

interface Resolved {
  readonly link: PowerSourceLink
  readonly switchDevice: PowerSourceDevice
}

type Lookup =
  | { readonly kind: 'found'; readonly resolved: Resolved }
  | {
      readonly kind: 'refused'
      readonly reason: PowerSourceRefusalReason
      readonly message: string
    }

interface PendingRestart {
  /** Null until the switch is resolved. */
  switchId: number | null
  timer: PowerSourceTimer | null
}

const ACCEPTED: PowerSourceActionResult = { accepted: true }

export class PowerSourceService implements IPowerSourceProvider {
  /** Restarts whose switch-on has not run yet, by device id. */
  private readonly restarting = new Map<number, PendingRestart>()

  constructor(private readonly deps: PowerSourceServiceDeps) {}

  getStatus = async ({ deviceId }: { deviceId: number }): Promise<PowerSourceInfo> => {
    const link = await this.linkOf(deviceId)
    if (link === null) {
      return {
        linked: false,
        switchDeviceId: null,
        switchName: null,
        switchOn: null,
        switchOnline: null,
        restartInProgress: false,
        offSeconds: 0,
      }
    }
    const switchDevice = await this.deps.devices.find(link.switch).catch(() => null)
    const switchOn =
      switchDevice === null
        ? null
        : await this.deps.devices.readOn(switchDevice.id).catch(() => null)
    return {
      linked: true,
      switchDeviceId: switchDevice?.id ?? null,
      switchName: switchDevice?.name ?? link.switch.stableId,
      switchOn,
      switchOnline: switchDevice?.online ?? null,
      restartInProgress: this.restarting.has(deviceId),
      offSeconds: link.offSeconds,
    }
  }

  powerOn = ({ deviceId }: { deviceId: number }): Promise<PowerSourceActionResult> =>
    this.switchTo(deviceId, true, 'power on')

  powerOff = ({ deviceId }: { deviceId: number }): Promise<PowerSourceActionResult> =>
    this.switchTo(deviceId, false, 'power off')

  forceRestart = async ({ deviceId }: { deviceId: number }): Promise<PowerSourceActionResult> => {
    // The slot is taken BEFORE the first await, so two concurrent calls cannot both pass.
    if (this.restarting.has(deviceId)) {
      return this.refuse(deviceId, 'restart-in-progress', 'a restart is already in progress', null)
    }
    const pending: PendingRestart = { switchId: null, timer: null }
    this.restarting.set(deviceId, pending)
    const lookup = await this.lookup(deviceId)
    if (lookup.kind === 'refused') {
      this.restarting.delete(deviceId)
      return this.refuse(deviceId, lookup.reason, lookup.message, null)
    }
    const { link, switchDevice } = lookup.resolved
    const switchId = switchDevice.id
    pending.switchId = switchId
    try {
      await this.deps.devices.setOn(switchId, false)
    } catch (err: unknown) {
      this.restarting.delete(deviceId)
      return this.refuse(deviceId, 'switch-call-failed', errorText(err), switchId)
    }
    this.deps.logger.info('power-source: forced restart, power is off', {
      tags: { deviceId },
      meta: {
        switchId,
        switchName: switchDevice.name,
        offSeconds: link.offSeconds,
      },
    })
    pending.timer = this.deps.scheduler.schedule(link.offSeconds * 1000, () => {
      void this.finishRestart(deviceId, switchId)
    })
    return ACCEPTED
  }

  /** Cancel every pending switch-on. The switch stays off, and each one is logged by name. */
  stop(): void {
    for (const [deviceId, pending] of this.restarting) {
      pending.timer?.cancel()
      this.deps.logger.warn(
        'power-source: restart cancelled on stop, the pending switch-on will not run and the switch stays OFF',
        { tags: { deviceId }, meta: { switchId: pending.switchId } },
      )
    }
    this.restarting.clear()
  }

  private async finishRestart(deviceId: number, switchId: number): Promise<void> {
    try {
      await this.deps.devices.setOn(switchId, true)
      this.deps.logger.info('power-source: forced restart finished, power is on', {
        tags: { deviceId },
        meta: { switchId },
      })
    } catch (err: unknown) {
      this.deps.logger.error(
        'power-source: the switch-on after a forced restart FAILED, the switch stays off',
        { tags: { deviceId }, meta: { switchId, error: errorText(err) } },
      )
    } finally {
      this.restarting.delete(deviceId)
    }
  }

  private async switchTo(
    deviceId: number,
    on: boolean,
    action: string,
  ): Promise<PowerSourceActionResult> {
    if (this.restarting.has(deviceId)) {
      return this.refuse(deviceId, 'restart-in-progress', `${action} during a restart`, null)
    }
    const lookup = await this.lookup(deviceId)
    if (lookup.kind === 'refused') return this.refuse(deviceId, lookup.reason, lookup.message, null)
    const { switchDevice } = lookup.resolved
    try {
      await this.deps.devices.setOn(switchDevice.id, on)
    } catch (err: unknown) {
      return this.refuse(deviceId, 'switch-call-failed', errorText(err), switchDevice.id)
    }
    this.deps.logger.info(`power-source: ${action}`, {
      tags: { deviceId },
      meta: { switchId: switchDevice.id, switchName: switchDevice.name },
    })
    return ACCEPTED
  }

  /** The link and the switch, or the reason there is nothing to act on. Reads the switch state: unknown is refused. */
  private async lookup(deviceId: number): Promise<Lookup> {
    const link = await this.linkOf(deviceId)
    if (link === null) {
      return {
        kind: 'refused',
        reason: 'no-power-source',
        message: 'no power source is linked',
      }
    }
    const switchDevice = await this.deps.devices.find(link.switch).catch(() => null)
    if (switchDevice === null) {
      return {
        kind: 'refused',
        reason: 'switch-missing',
        message: `the linked switch ${link.switch.stableId} cannot be found`,
      }
    }
    if (!switchDevice.online) {
      return {
        kind: 'refused',
        reason: 'switch-offline',
        message: `the switch ${switchDevice.name} is offline`,
      }
    }
    const on = await this.deps.devices.readOn(switchDevice.id).catch(() => null)
    if (on === null) {
      return {
        kind: 'refused',
        reason: 'switch-unknown',
        message: `the state of the switch ${switchDevice.name} is unknown`,
      }
    }
    return { kind: 'found', resolved: { link, switchDevice } }
  }

  /** The stored link of the device `deviceId`, read from the customizations now. */
  private async linkOf(deviceId: number): Promise<PowerSourceLink | null> {
    for (const block of this.deps.blocks()) {
      const link = powerSourceLinkOfComposition(coreBlockComposition(block))
      if (link === null) continue
      const device = await this.deps.devices.find(link.device).catch(() => null)
      if (device !== null && device.id === deviceId) return link
    }
    return null
  }

  private refuse(
    deviceId: number,
    reason: PowerSourceRefusalReason,
    message: string,
    switchId: number | null,
  ): PowerSourceActionResult {
    this.deps.logger.warn(`power-source: refused (${reason})`, {
      tags: { deviceId },
      meta: { reason, switchId, message },
    })
    return { accepted: false, reason, message }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
