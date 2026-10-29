/**
 * The commands of a BUILT capability (D659, amended by D967).
 *
 * A composed device of a new type serves a method of its cap by calling a
 * method of ONE source device's cap. The call travels the actuator dispatch
 * path (`ComposedDevice.dispatch` → `ActuatorGroups.command`), which hands it
 * here when the device has forwards; this module owns what is specific to a
 * forward: finding the command, mapping the input, resolving the source and
 * refusing with a typed reason that NAMES the source.
 *
 * Mapping (`args` absent): the caller's input passes through, `deviceId`
 * removed, and the source's own `deviceId` is the one injected by the call.
 * Mapping (`args` present): the template is the whole input — constants are
 * sent as they are, `{ $input: 'field' }` is replaced by that field of the
 * caller's input, at any depth. A field the caller left undefined is left out.
 *
 * An item's `reset` (consumables) is addressed by `args.key`, the item key.
 * The source is resolved against the device index on EVERY command, never from
 * a remembered id: a source that was deleted and re-created is a new device.
 */
import {
  type CompositionFieldsFeature,
  type CompositionForwardArg,
  type CompositionForwardCommand,
  type CompositionSourceRef,
  compositionSourceKey,
  DEVICE_ID_FIELD,
  errMsg,
  featureForwards,
  isForwardInputRef,
  type IScopedLogger,
} from '@camstack/types'
import type { ActuatorDispatchInput } from './actuator-dispatch.js'
import type { SourceResolution } from './source-readings.js'

/** Why a forward did not reach its source. */
export type ForwardRefusalReason =
  | 'no-command'
  | 'source-gone'
  | 'source-unknown'
  | 'source-call-failed'

/** A forward refused: the message names the source and the reason. */
export class ForwardRefusedError extends Error {
  constructor(
    readonly reason: ForwardRefusalReason,
    readonly source: string,
    detail: string,
  ) {
    super(`forward to ${source} refused (${reason}): ${detail}`)
    this.name = 'ForwardRefusedError'
  }
}

export interface ForwardBlock {
  readonly id: string
  readonly features: readonly CompositionFieldsFeature[]
}

export interface ForwardCommandsDeps {
  readonly logger: IScopedLogger
  /** The source ref against the device index, read afresh (the tracker's `resolve(ref, true)`). */
  readonly resolve: (ref: CompositionSourceRef) => Promise<SourceResolution>
  /** `api.<cap>.<method>.mutate({ deviceId, ...args })` — a rejection is the source's own. */
  readonly callCapMethod: (
    deviceId: number,
    cap: string,
    method: string,
    args: Readonly<Record<string, unknown>>,
  ) => Promise<void>
  /** The composed device id of a block, null while it has none. */
  readonly deviceIdOf: (blockId: string) => number | null
}

interface DeviceForwards {
  readonly byMethod: ReadonlyMap<string, CompositionForwardCommand>
  readonly resets: ReadonlyMap<string, ReadonlyMap<string, CompositionForwardCommand>>
}

function methodKey(cap: string, method: string): string {
  return `${cap}.${method}`
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The template with every `$input` replaced; an undefined replacement drops its key. */
function substitute(arg: CompositionForwardArg, input: Readonly<Record<string, unknown>>): unknown {
  if (typeof arg !== 'object') return arg
  if (isForwardInputRef(arg)) return input[arg.$input]
  return Object.fromEntries(
    Object.entries(arg)
      .map(([key, value]) => [key, substitute(value, input)] as const)
      .filter(([, value]) => value !== undefined),
  )
}

/** The arguments a forward sends: the template, or the caller's input minus the device id. */
export function forwardArguments(
  command: CompositionForwardCommand,
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (command.args === undefined) {
    return Object.fromEntries(
      Object.entries(input).filter(
        ([key, value]) => key !== DEVICE_ID_FIELD && value !== undefined,
      ),
    )
  }
  const built = substitute(command.args, input)
  return isRecord(built) ? built : {}
}

export class ForwardCommands {
  private devices: ReadonlyMap<number, DeviceForwards> = new Map()

  constructor(private readonly deps: ForwardCommandsDeps) {}

  /** The forwards of every block that has any, keyed by its composed device. */
  sync(blocks: readonly ForwardBlock[]): void {
    const next = new Map<number, DeviceForwards>()
    for (const block of blocks) {
      const deviceId = this.deps.deviceIdOf(block.id)
      if (deviceId === null) continue
      const byMethod = new Map<string, CompositionForwardCommand>()
      const resets = new Map<string, Map<string, CompositionForwardCommand>>()
      for (const feature of block.features) {
        for (const forward of featureForwards(feature, 0)) {
          if (forward.itemKey === undefined) {
            byMethod.set(methodKey(feature.cap, forward.method), forward.command)
            continue
          }
          const items = resets.get(feature.cap) ?? new Map<string, CompositionForwardCommand>()
          items.set(forward.itemKey, forward.command)
          resets.set(feature.cap, items)
        }
      }
      if (byMethod.size > 0 || resets.size > 0) next.set(deviceId, { byMethod, resets })
    }
    this.devices = next
  }

  /** True when this composed device is commanded by forwards: the caller hands its commands here. */
  serves(groupDeviceId: number): boolean {
    return this.devices.has(groupDeviceId)
  }

  async command(input: ActuatorDispatchInput): Promise<void> {
    const forwards = this.devices.get(input.groupDeviceId)
    const command = forwards === undefined ? undefined : this.commandFor(forwards, input)
    if (command === undefined) {
      this.deps.logger.warn('forward command dropped — this method has no command', {
        tags: { deviceId: input.groupDeviceId },
        meta: { cap: input.cap, method: input.method },
      })
      throw new ForwardRefusedError(
        'no-command',
        `${input.cap}.${input.method}`,
        'the composition gives this method no command',
      )
    }
    const source = compositionSourceKey(command.source)
    const sent = forwardArguments(command, this.callerInput(input))
    const resolved = await this.resolveOrRefuse(input, command, source)
    try {
      await this.deps.callCapMethod(resolved, command.cap, command.method, sent)
    } catch (err: unknown) {
      this.refuse(input, 'source-call-failed', source, errMsg(err), resolved)
    }
  }

  /** A reset carries the item key, which selects the command and is not an argument. */
  private callerInput(input: ActuatorDispatchInput): Readonly<Record<string, unknown>> {
    return input.method === 'reset' && 'key' in input.args ? {} : input.args
  }

  private commandFor(
    forwards: DeviceForwards,
    input: ActuatorDispatchInput,
  ): CompositionForwardCommand | undefined {
    if (input.method === 'reset') {
      const key = input.args.key
      const items = forwards.resets.get(input.cap)
      if (typeof key === 'string' && items !== undefined) return items.get(key)
    }
    return forwards.byMethod.get(methodKey(input.cap, input.method))
  }

  private async resolveOrRefuse(
    input: ActuatorDispatchInput,
    command: CompositionForwardCommand,
    source: string,
  ): Promise<number> {
    let resolution: SourceResolution
    try {
      resolution = await this.deps.resolve(command.source)
    } catch (err: unknown) {
      return this.refuse(input, 'source-unknown', source, errMsg(err))
    }
    if (resolution.kind === 'found') return resolution.deviceId
    if (resolution.kind === 'missing')
      return this.refuse(input, 'source-gone', source, resolution.reason)
    return this.refuse(input, 'source-unknown', source, resolution.error)
  }

  private refuse(
    input: ActuatorDispatchInput,
    reason: ForwardRefusalReason,
    source: string,
    detail: string,
    sourceDeviceId?: number,
  ): never {
    this.deps.logger.warn('forward command failed — nothing was changed on the source', {
      tags: { deviceId: input.groupDeviceId },
      meta: {
        cap: input.cap,
        method: input.method,
        source,
        reason,
        error: detail,
        ...(sourceDeviceId === undefined ? {} : { sourceDeviceId }),
      },
    })
    throw new ForwardRefusedError(reason, source, detail)
  }
}
