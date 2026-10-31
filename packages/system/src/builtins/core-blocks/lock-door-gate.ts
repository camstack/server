/**
 * The lock's door gate (D984), a second authority of the device-call redirect
 * (D963): while the door contact linked to a lock reads OPEN, `lock-control.lock`
 * is refused at DISPATCH, so it holds for every caller (the admin UI, an
 * automation, an exporter, a forked addon). `unlock` is never blocked.
 *
 * The decision is in-memory state fed from `device.state-changed` OFF the
 * command path (D49): a lock whose composed `state` reads `door-open` has its
 * door open. A lock never heard from since boot is UNKNOWN — it is not blocked
 * (a failed read must not lock an operator out of locking), and it is logged
 * once, with the device tag.
 */
import type {
  DeviceCall,
  DeviceCallAnswer,
  DeviceCallRedirect,
  IScopedLogger,
} from '@camstack/types'
import type { DeviceStateChangedData } from '../shared/device-state-changed.js'

const LOCK_CONTROL = 'lock-control'
const DOOR_OPEN = 'door-open'
const NOT_REDIRECTED: DeviceCallAnswer = { kind: 'not-redirected' }

export interface LockDoorGateDeps {
  /** Label of the door sensor linked to this lock, or null when none is linked. Asked only off the hot path. */
  readonly sensorOf: (deviceId: number) => Promise<string | null>
  readonly logger: IScopedLogger
}

export class LockDoorGate {
  private readonly doorOpen = new Map<number, boolean>()
  private readonly unknownLogged = new Set<number>()

  constructor(private readonly deps: LockDoorGateDeps) {}

  /** Feed from the bus; the lock's merged `state` is the one signal. */
  onStateChanged(data: DeviceStateChangedData): void {
    if (data.capName !== LOCK_CONTROL) return
    const state = data.slice['state']
    if (typeof state !== 'string') return
    this.doorOpen.set(data.deviceId, state === DOOR_OPEN)
    this.unknownLogged.delete(data.deviceId)
  }

  redirect(): DeviceCallRedirect {
    return {
      covers: (capName, method) => capName === LOCK_CONTROL && method === 'lock',
      attempt: (call) => this.attempt(call),
    }
  }

  private async attempt(call: DeviceCall): Promise<DeviceCallAnswer> {
    const known = this.doorOpen.get(call.deviceId)
    if (known === false) return NOT_REDIRECTED
    const sensor = await this.deps.sensorOf(call.deviceId)
    if (known === undefined) {
      if (sensor !== null && !this.unknownLogged.has(call.deviceId)) {
        this.unknownLogged.add(call.deviceId)
        this.deps.logger.info('lock: the door contact state is unknown, lock() is not blocked', {
          tags: { deviceId: call.deviceId },
          meta: { sensor },
        })
      }
      return NOT_REDIRECTED
    }
    const named = sensor ?? 'its door contact'
    this.deps.logger.warn('lock: lock() refused, the door is open', {
      tags: { deviceId: call.deviceId },
      meta: { sensor: named },
    })
    throw new Error(`lock refused: the door is open (${named} reads open)`)
  }
}

/** One slot, several authorities: the first that covers the call and takes it over answers. */
export function composeRedirects(redirects: readonly DeviceCallRedirect[]): DeviceCallRedirect {
  return {
    covers: (capName, method) => redirects.some((r) => r.covers(capName, method)),
    attempt: async (call) => {
      for (const redirect of redirects) {
        if (!redirect.covers(call.capName, call.method)) continue
        const answer = await redirect.attempt(call)
        if (answer.kind === 'redirected') return answer
      }
      return NOT_REDIRECTED
    },
  }
}
