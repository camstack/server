import type { IScopedLogger } from '@camstack/types'
import {
  EspServiceError,
  type EspLink,
  type EspServiceArgType,
  type EspServiceArgValue,
  type EspServiceInfo,
} from './esphome-link.js'

/** Longest serialized argument payload written to a log line. */
const LOG_ARGS_MAX_CHARS = 200

export interface EspServiceRunnerDeps {
  /** The live session of a board, or null when it is not reachable. */
  readonly getLink: (brokerId: string) => EspLink | null
  readonly logger: IScopedLogger
}

function isNumberArray(value: unknown, whole: boolean): value is readonly number[] {
  return (
    Array.isArray(value) &&
    value.every(
      (v) => typeof v === 'number' && Number.isFinite(v) && (!whole || Number.isInteger(v)),
    )
  )
}

/** True when `value` has the shape the board declared for the argument. */
function matchesType(type: EspServiceArgType, value: unknown): boolean {
  switch (type) {
    case 'bool':
      return typeof value === 'boolean'
    case 'int':
      return typeof value === 'number' && Number.isInteger(value)
    case 'float':
      return typeof value === 'number' && Number.isFinite(value)
    case 'string':
      return typeof value === 'string'
    case 'bool[]':
      return Array.isArray(value) && value.every((v) => typeof v === 'boolean')
    case 'int[]':
      return isNumberArray(value, true)
    case 'float[]':
      return isNumberArray(value, false)
    case 'string[]':
      return Array.isArray(value) && value.every((v) => typeof v === 'string')
  }
}

/**
 * Check a call against the service the board listed. Throws {@link EspServiceError}
 * `unknown-service` / `bad-argument`; nothing is sent before this passes.
 */
export function validateServiceCall(
  services: readonly EspServiceInfo[],
  name: string,
  args: Readonly<Record<string, EspServiceArgValue>>,
): EspServiceInfo {
  const service = services.find((s) => s.name === name)
  if (service === undefined) {
    throw new EspServiceError('unknown-service', `the board has no service '${name}'`)
  }
  const declared = new Set(service.args.map((a) => a.name))
  for (const given of Object.keys(args)) {
    if (!declared.has(given)) {
      throw new EspServiceError('bad-argument', `service '${name}' has no argument '${given}'`)
    }
  }
  for (const arg of service.args) {
    const value = args[arg.name]
    if (value === undefined) {
      throw new EspServiceError('bad-argument', `service '${name}' needs argument '${arg.name}'`)
    }
    if (!matchesType(arg.type, value)) {
      throw new EspServiceError(
        'bad-argument',
        `argument '${arg.name}' of '${name}' must be ${arg.type}`,
      )
    }
  }
  return service
}

function truncatedArgs(args: Readonly<Record<string, EspServiceArgValue>>): string {
  const text = JSON.stringify(args)
  return text.length <= LOG_ARGS_MAX_CHARS
    ? text
    : `${text.slice(0, LOG_ARGS_MAX_CHARS)}... (${text.length} chars)`
}

/** List and run the user-defined services of connected boards. */
export class EspServiceRunner {
  constructor(private readonly deps: EspServiceRunnerDeps) {}

  listServices(brokerId: string): readonly EspServiceInfo[] {
    return this.requireLink(brokerId).listServices()
  }

  /** `deviceId` tags the log line when the call is made on behalf of a device. */
  async executeService(
    brokerId: string,
    name: string,
    args: Readonly<Record<string, EspServiceArgValue>>,
    deviceId?: number,
  ): Promise<void> {
    const tags = deviceId !== undefined ? { tags: { deviceId } } : {}
    try {
      const link = this.requireLink(brokerId)
      validateServiceCall(link.listServices(), name, args)
      await link.executeService(name, args)
    } catch (err: unknown) {
      const reason = err instanceof EspServiceError ? err.reason : 'send-failed'
      this.deps.logger.warn('esphome: service refused', {
        ...tags,
        meta: {
          brokerId,
          service: name,
          reason,
          error: err instanceof Error ? err.message : String(err),
        },
      })
      throw err
    }
    this.deps.logger.info('esphome: service executed', {
      ...tags,
      meta: { brokerId, service: name, args: truncatedArgs(args) },
    })
  }

  private requireLink(brokerId: string): EspLink {
    const link = this.deps.getLink(brokerId)
    if (link === null) {
      throw new EspServiceError('not-connected', `ESPHome board '${brokerId}' is not connected`)
    }
    return link
  }
}
