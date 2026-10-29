/**
 * Turns a parsed SmartIR command table (`parseSmartIr`, the one parser in
 * `ir/`) into a draft of the `remote` configuration (D963): the role each
 * command fills and the binding that sends its pulse train through an
 * `ir-transmitter`.
 *
 * PURE and browser-safe: the admin UI parses the file the operator picked,
 * builds this draft and saves it on the cap; the server never receives a code
 * file. A command whose payload cannot be resolved to a pulse train comes back
 * in `skipped` with the reason, never dropped silently.
 */
import { IrCodecError } from '../ir/ir-error.js'
import { toTimings } from '../ir/ir-payload.js'
import type { IrTimings, TransmitSettings } from '../ir/ir-timings.js'
import type { RemoteCommandTable } from '../ir/smartir.js'
import type { RemoteBinding, RemoteCustomButton, RemotePowerMode } from './remote-config.js'
import { customRole } from './remote-roles.js'

/** SmartIR's own command keys and the role each one fills. */
const KNOWN_KEY_ROLES: Readonly<Record<string, string>> = {
  previousChannel: 'channel_down',
  nextChannel: 'channel_up',
  volumeDown: 'volume_down',
  volumeUp: 'volume_up',
  mute: 'mute',
}

/** The transmitter that sends a draft's codes unless a command names its own. */
export interface SmartIrTarget {
  readonly transmitterDeviceId: number
}

export interface SmartIrSkipped {
  readonly name: string
  readonly reason: string
}

export interface SmartIrDraft {
  readonly bindings: Record<string, RemoteBinding>
  readonly customButtons: RemoteCustomButton[]
  readonly power: { readonly mode: RemotePowerMode }
  readonly skipped: SmartIrSkipped[]
}

interface ResolvedCommand {
  readonly name: string
  readonly group: 'command' | 'source'
  readonly timings: IrTimings
  readonly settings: TransmitSettings
  readonly transmitterDeviceId: number
}

function slug(text: string): string {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return base.length > 0 ? base.slice(0, 40) : 'button'
}

function sameTrain(a: ResolvedCommand, b: ResolvedCommand): boolean {
  return a.timings.length === b.timings.length && a.timings.every((p, i) => p === b.timings[i])
}

function bindingOf(command: ResolvedCommand): RemoteBinding {
  const hasSettings = Object.keys(command.settings).length > 0
  return {
    action: {
      kind: 'cap',
      deviceId: command.transmitterDeviceId,
      cap: 'ir-transmitter',
      method: 'send',
      args: {
        timings: command.timings,
        ...(hasSettings ? { settings: command.settings } : {}),
      },
    },
  }
}

function resolveAll(
  table: RemoteCommandTable,
  target: SmartIrTarget,
  skipped: SmartIrSkipped[],
): ResolvedCommand[] {
  const out: ResolvedCommand[] = []
  for (const command of table.commands) {
    try {
      const { timings, settings } = toTimings(command.payload)
      out.push({
        name: command.name,
        group: command.group,
        timings,
        settings,
        transmitterDeviceId: command.transmitterDeviceId ?? target.transmitterDeviceId,
      })
    } catch (err: unknown) {
      if (!(err instanceof IrCodecError)) throw err
      skipped.push({ name: command.name, reason: err.message })
    }
  }
  return out
}

/**
 * `on` and `off` carrying the SAME pulse train are one power TOGGLE (bound to
 * `power`); different trains are a discrete pair (`power_on` / `power_off`). A
 * command SmartIR knows fills its role; a source, or any command it does not
 * know, becomes a custom button named as the file spells it.
 */
export function smartIrDraft(table: RemoteCommandTable, target: SmartIrTarget): SmartIrDraft {
  const skipped: SmartIrSkipped[] = []
  const commands = resolveAll(table, target, skipped)
  const bindings: Record<string, RemoteBinding> = {}
  const customButtons: RemoteCustomButton[] = []
  const usedKeys = new Set<string>()
  const addCustom = (command: ResolvedCommand, prefix: string): void => {
    let key = prefix + slug(command.name)
    for (let n = 2; usedKeys.has(key); n += 1) key = `${prefix}${slug(command.name)}_${n}`
    usedKeys.add(key)
    customButtons.push({ key, name: command.name })
    bindings[customRole(key)] = bindingOf(command)
  }

  const find = (name: string): ResolvedCommand | undefined =>
    commands.find((c) => c.group === 'command' && c.name === name)
  const on = find('on')
  const off = find('off')
  let mode: RemotePowerMode = 'discrete'
  if (on !== undefined && off !== undefined && sameTrain(on, off)) {
    mode = 'toggle'
    bindings['power'] = bindingOf(on)
  } else {
    if (on !== undefined) bindings['power_on'] = bindingOf(on)
    if (off !== undefined) bindings['power_off'] = bindingOf(off)
  }

  for (const command of commands) {
    if (command.group === 'source') {
      addCustom(command, 'source_')
      continue
    }
    if (command.name === 'on' || command.name === 'off') continue
    const role = KNOWN_KEY_ROLES[command.name]
    if (role !== undefined) bindings[role] = bindingOf(command)
    else addCustom(command, '')
  }
  return { bindings, customButtons, power: { mode }, skipped }
}
