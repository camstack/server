/**
 * The device-call redirect the remote installs into the capability registry
 * (D963): precedence at DISPATCH, so it holds for every caller — the admin UI,
 * an automation, an exporter, a forked addon — never in a UI.
 *
 * - A media-player command (`play`, `pause`, `stop`, `next`, `previous`,
 *   `setMute`, `selectSource`) on a device whose remote binds the command's
 *   role runs the binding. An unbound role falls through to the native cap.
 *   A binding that FAILS fails the call: the native cap never silently runs in
 *   its place. `repeat`, where the caller supplies one, is passed through.
 * - `getStatus` is answered from the remote's own bookkeeping — marked
 *   `assumed` — only when NO running source exists for the device. A device
 *   with a native media-player cap is reported by it, as before.
 */
import {
  type DeviceCall,
  type DeviceCallAnswer,
  type DeviceCallRedirect,
  type IScopedLogger,
  REMOTE_MAX_REPEAT,
  type RemoteMediaCommand,
} from '@camstack/types'
import type { RemoteService } from './remote-service.js'

const MEDIA_PLAYER = 'media-player'

const COMMANDS: ReadonlySet<string> = new Set<RemoteMediaCommand>([
  'play',
  'pause',
  'stop',
  'next',
  'previous',
  'setMute',
  'selectSource',
])

export interface RemoteCallRedirectDeps {
  readonly remote: Pick<RemoteService, 'sendMediaCommand' | 'assumedStatus'>
  /** Whether a running source (the native media-player cap) exists for the device. */
  readonly hasNative: (deviceId: number) => boolean
  readonly logger: IScopedLogger
}

function isCommand(method: string): method is RemoteMediaCommand {
  return COMMANDS.has(method)
}

function field(args: unknown, key: string): unknown {
  return args !== null && typeof args === 'object' ? Reflect.get(args, key) : undefined
}

function repeatOf(args: unknown): number {
  const raw = field(args, 'repeat')
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) return 1
  return Math.min(raw, REMOTE_MAX_REPEAT)
}

export function remoteCallRedirect(deps: RemoteCallRedirectDeps): DeviceCallRedirect {
  const status = async (call: DeviceCall): Promise<DeviceCallAnswer> => {
    if (deps.hasNative(call.deviceId)) return { kind: 'not-redirected' }
    const assumed = await deps.remote.assumedStatus(call.deviceId)
    return assumed === null ? { kind: 'not-redirected' } : { kind: 'redirected', result: assumed }
  }

  const command = async (call: DeviceCall, name: RemoteMediaCommand): Promise<DeviceCallAnswer> => {
    const muted = field(call.args, 'muted')
    const source = field(call.args, 'source')
    const result = await deps.remote.sendMediaCommand({
      deviceId: call.deviceId,
      command: name,
      ...(typeof muted === 'boolean' ? { muted } : {}),
      ...(typeof source === 'string' ? { source } : {}),
      repeat: repeatOf(call.args),
    })
    switch (result.status) {
      case 'not-routed':
        return { kind: 'not-redirected' }
      case 'sent':
      case 'skipped':
        return { kind: 'redirected', result: undefined }
      case 'refused':
        deps.logger.warn('remote: a media-player command bound to the remote was refused', {
          tags: { deviceId: call.deviceId },
          meta: { command: name, reason: result.reason, detail: result.detail },
        })
        throw new Error(
          `remote: ${name} refused (${result.reason}${result.detail === undefined ? '' : `: ${result.detail}`})`,
        )
    }
  }

  return {
    covers: (capName, method) =>
      capName === MEDIA_PLAYER && (method === 'getStatus' || isCommand(method)),
    attempt: async (call) => {
      if (call.method === 'getStatus') return status(call)
      return isCommand(call.method) ? command(call, call.method) : { kind: 'not-redirected' }
    },
  }
}
