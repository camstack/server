import {
  AuthenticationError,
  ConnectionRefusedError,
  ConnectionTimeoutError,
  EncryptionKeyInvalidError,
  EncryptionKeyMissingError,
  EncryptionRequiredError,
  EntityCategory,
  EspHomeError,
  entityId,
  IncompatibleApiVersionError,
  NegotiationFailedError,
  openEspHomeClient,
  ServiceArgType,
  type Entity,
  type EspHomeClient,
  type ExecuteServiceArgumentValue,
  type TelemetryEvent,
} from 'esphome-client'
import type { EspConnection } from './config.js'
import {
  EspLinkError,
  EspServiceError,
  type EspServiceArgType,
  type EspServiceArgValue,
  type EspServiceInfo,
  type EspBoardInfo,
  type EspCommand,
  type EspEntity,
  type EspEntityCategory,
  type EspFailureReason,
  type EspLink,
  type EspLinkFactory,
  type EspState,
} from './esphome-link.js'

/** Light colour-mode capability bit for "can dim" (the library exposes the raw flag set). */
const COLOUR_MODE_BRIGHTNESS_BIT = 2

const CONNECT_TIMEOUT_MS = 8_000

/**
 * Keys of error messages carried to the operator. The library's own messages
 * never include the key, but a message is still cut to one line and bounded so
 * nothing unexpected rides along.
 */
function safeMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return (text.split('\n')[0] ?? '').slice(0, 200)
}

/** Map a library failure to the addon's reason vocabulary. */
export function classifyFailure(err: unknown): EspLinkError {
  if (err instanceof EspLinkError) return err
  const message = safeMessage(err)
  const reason = ((): EspFailureReason => {
    if (err instanceof EncryptionKeyMissingError) return 'encryption-key-missing'
    if (err instanceof EncryptionKeyInvalidError) return 'encryption-key-invalid'
    if (err instanceof EncryptionRequiredError) return 'encryption-required'
    if (err instanceof AuthenticationError) return 'auth'
    if (err instanceof IncompatibleApiVersionError || err instanceof NegotiationFailedError) {
      return 'incompatible'
    }
    if (err instanceof ConnectionRefusedError) return 'refused'
    if (err instanceof ConnectionTimeoutError) return 'timeout'
    if (err instanceof EspHomeError) return 'unreachable'
    return 'error'
  })()
  return new EspLinkError(reason, message)
}

/** The branded library id for an entity id this addon already holds (`<type>-<objectId>`). */
function entityRef<T extends string>(type: T, id: string): ReturnType<typeof entityId<T>> {
  return entityId(type, id.slice(type.length + 1))
}

function categoryOf(entity: Entity): EspEntityCategory {
  if (entity.entityCategory === EntityCategory.CONFIG) return 'config'
  if (entity.entityCategory === EntityCategory.DIAGNOSTIC) return 'diagnostic'
  return 'none'
}

function baseEntity(entity: Entity, id: string): Omit<EspEntity, 'type'> {
  return {
    id,
    name: entity.name,
    deviceClass: '',
    category: categoryOf(entity),
    disabledByDefault: entity.disabledByDefault === true,
    unit: '',
    supportsPosition: false,
    supportsStop: false,
    isStatusBinarySensor: false,
    supportsBrightness: false,
    min: null,
    max: null,
    step: null,
    options: [],
    eventTypes: [],
  }
}

/** Translate one library entity, or null for a kind this addon does not map. */
export function toEspEntity(entity: Entity): EspEntity | null {
  const id = entityId(entity.type, entity.objectId)
  const base = baseEntity(entity, id)
  switch (entity.type) {
    case 'switch':
      return { ...base, type: 'switch', deviceClass: entity.deviceClass ?? '' }
    case 'button':
      return { ...base, type: 'button', deviceClass: entity.deviceClass ?? '' }
    case 'light':
      return {
        ...base,
        type: 'light',
        supportsBrightness: (entity.supportedColorModes ?? []).some(
          (mode) => (mode & COLOUR_MODE_BRIGHTNESS_BIT) !== 0,
        ),
      }
    case 'cover':
      return {
        ...base,
        type: 'cover',
        deviceClass: entity.deviceClass ?? '',
        supportsPosition: entity.supportsPosition === true,
        supportsStop: entity.supportsStop === true,
      }
    case 'number':
      return {
        ...base,
        type: 'number',
        deviceClass: entity.deviceClass ?? '',
        unit: entity.unitOfMeasurement ?? '',
        min: entity.minValue ?? null,
        max: entity.maxValue ?? null,
        step: entity.step ?? null,
      }
    case 'select':
      return { ...base, type: 'select', options: entity.options ?? [] }
    case 'event':
      return {
        ...base,
        type: 'event',
        deviceClass: entity.deviceClass ?? '',
        eventTypes: entity.eventTypes ?? [],
      }
    case 'sensor':
      return {
        ...base,
        type: 'sensor',
        deviceClass: entity.deviceClass ?? '',
        unit: entity.unitOfMeasurement ?? '',
      }
    case 'binary_sensor':
      return {
        ...base,
        type: 'binary_sensor',
        deviceClass: entity.deviceClass ?? '',
        isStatusBinarySensor: entity.isStatusBinarySensor === true,
      }
    case 'text_sensor':
      return { ...base, type: 'text_sensor', deviceClass: entity.deviceClass ?? '' }
    default:
      return null
  }
}

/** Translate one library state event, or null for a kind this addon does not map. */
export function toEspState(event: TelemetryEvent): EspState | null {
  const id = event.entity
  switch (event.type) {
    case 'switch':
      return { type: 'switch', id, ...(event.state !== undefined ? { state: event.state } : {}) }
    case 'light':
      return {
        type: 'light',
        id,
        ...(event.state !== undefined ? { state: event.state } : {}),
        ...(event.brightness !== undefined ? { brightness: event.brightness } : {}),
      }
    case 'cover':
      return {
        type: 'cover',
        id,
        ...(event.position !== undefined ? { position: event.position } : {}),
        ...(event.currentOperation !== undefined
          ? { currentOperation: event.currentOperation }
          : {}),
      }
    case 'number':
      return {
        type: 'number',
        id,
        ...(event.state !== undefined ? { state: event.state } : {}),
        ...(event.missingState === true ? { missingState: true } : {}),
      }
    case 'select':
      return {
        type: 'select',
        id,
        ...(event.state !== undefined ? { state: event.state } : {}),
        ...(event.missingState === true ? { missingState: true } : {}),
      }
    case 'sensor':
      return {
        type: 'sensor',
        id,
        ...(event.state !== undefined ? { state: event.state } : {}),
        ...(event.missingState === true ? { missingState: true } : {}),
      }
    case 'binary_sensor':
      return {
        type: 'binary_sensor',
        id,
        ...(event.state !== undefined ? { state: event.state } : {}),
        ...(event.missingState === true ? { missingState: true } : {}),
      }
    case 'text_sensor':
      return {
        type: 'text_sensor',
        id,
        ...(event.state !== undefined ? { state: event.state } : {}),
        ...(event.missingState === true ? { missingState: true } : {}),
      }
    case 'event':
      return {
        type: 'event',
        id,
        ...(event.eventType !== undefined ? { eventType: event.eventType } : {}),
      }
    default:
      return null
  }
}

const SERVICE_ARG_TYPES: Readonly<Record<number, EspServiceArgType>> = {
  [ServiceArgType.BOOL]: 'bool',
  [ServiceArgType.INT]: 'int',
  [ServiceArgType.FLOAT]: 'float',
  [ServiceArgType.STRING]: 'string',
  [ServiceArgType.BOOL_ARRAY]: 'bool[]',
  [ServiceArgType.INT_ARRAY]: 'int[]',
  [ServiceArgType.FLOAT_ARRAY]: 'float[]',
  [ServiceArgType.STRING_ARRAY]: 'string[]',
}

function isArrayOf<T>(value: unknown, guard: (v: unknown) => v is T): value is readonly T[] {
  return Array.isArray(value) && value.every(guard)
}
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const isNum = (v: unknown): v is number => typeof v === 'number'
const isStr = (v: unknown): v is string => typeof v === 'string'

/** One argument value in the wire library's tagged shape; null when it does not fit the type. */
function toWireArg(
  type: EspServiceArgType,
  value: EspServiceArgValue,
): ExecuteServiceArgumentValue | null {
  switch (type) {
    case 'bool':
      return isBool(value) ? { boolValue: value } : null
    case 'int':
      return isNum(value) ? { intValue: value } : null
    case 'float':
      return isNum(value) ? { floatValue: value } : null
    case 'string':
      return isStr(value) ? { stringValue: value } : null
    case 'bool[]':
      return isArrayOf(value, isBool) ? { boolArray: [...value] } : null
    case 'int[]':
      return isArrayOf(value, isNum) ? { intArray: [...value] } : null
    case 'float[]':
      return isArrayOf(value, isNum) ? { floatArray: [...value] } : null
    case 'string[]':
      return isArrayOf(value, isStr) ? { stringArray: [...value] } : null
  }
}

/** The real session over `esphome-client`. */
class ClientLink implements EspLink {
  private readonly client: EspHomeClient
  private readonly boardEntities: readonly EspEntity[]
  private readonly boardInfo: EspBoardInfo
  private readonly stateHandlers = new Set<(state: EspState) => void>()
  private readonly closeHandlers = new Set<(cause: EspLinkError | null) => void>()
  private readonly disposers: Disposable[] = []
  private closed = false
  private closedByUs = false

  constructor(client: EspHomeClient, encrypted: boolean) {
    this.client = client
    this.boardEntities = client
      .entitiesByDevice(undefined)
      .map(toEspEntity)
      .filter((e): e is EspEntity => e !== null)
    const info = client.deviceInfo()
    this.boardInfo = {
      name: info?.name ?? '',
      friendlyName: info?.friendlyName ?? '',
      model: info?.model ?? '',
      manufacturer: info?.manufacturer ?? '',
      esphomeVersion: info?.esphomeVersion ?? '',
      macAddress: info?.macAddress ?? '',
      encrypted,
    }
    this.disposers.push(
      client.on('telemetry', (event) => {
        const state = toEspState(event)
        if (state === null) return
        for (const handler of this.stateHandlers) handler(state)
      }),
      client.on('lifecycle', (event) => {
        if (event.kind !== 'disconnect') return
        this.finish(event.cause === undefined ? null : classifyFailure(event.cause))
      }),
    )
  }

  entities(): readonly EspEntity[] {
    return this.boardEntities
  }

  snapshot(): readonly EspState[] {
    const out: EspState[] = []
    for (const event of this.client.snapshot().values()) {
      const state = toEspState(event)
      if (state !== null) out.push(state)
    }
    return out
  }

  info(): EspBoardInfo {
    return this.boardInfo
  }

  onState(handler: (state: EspState) => void): () => void {
    this.stateHandlers.add(handler)
    return () => {
      this.stateHandlers.delete(handler)
    }
  }

  onClose(handler: (cause: EspLinkError | null) => void): () => void {
    this.closeHandlers.add(handler)
    return () => {
      this.closeHandlers.delete(handler)
    }
  }

  command(command: EspCommand): void {
    const id = command.id
    switch (command.type) {
      case 'switch':
        this.client.command(entityRef('switch', id), { state: command.state })
        return
      case 'light':
        this.client.command(entityRef('light', id), {
          ...(command.state !== undefined ? { state: command.state } : {}),
          ...(command.brightness !== undefined ? { brightness: command.brightness } : {}),
        })
        return
      case 'cover':
        this.client.command(entityRef('cover', id), {
          ...(command.position !== undefined ? { position: command.position } : {}),
          ...(command.stop === true ? { stop: true } : {}),
        })
        return
      case 'button':
        this.client.command(entityRef('button', id), {})
        return
      case 'number':
        this.client.command(entityRef('number', id), { state: command.state })
        return
      case 'select':
        this.client.command(entityRef('select', id), { state: command.state })
        return
    }
  }

  listServices(): readonly EspServiceInfo[] {
    const out: EspServiceInfo[] = []
    for (const service of this.client.services.list()) {
      const args: { name: string; type: EspServiceArgType }[] = []
      for (const arg of service.args) {
        const type = SERVICE_ARG_TYPES[arg.type]
        if (type !== undefined) args.push({ name: arg.name, type })
      }
      // A service with an argument type this library version cannot name is not offered.
      if (args.length === service.args.length) {
        out.push({ name: service.name, key: service.key, args })
      }
    }
    return out
  }

  async executeService(
    name: string,
    args: Readonly<Record<string, EspServiceArgValue>>,
  ): Promise<void> {
    const service = this.listServices().find((s) => s.name === name)
    if (service === undefined) {
      throw new EspServiceError('unknown-service', `the board has no service '${name}'`)
    }
    const wire: ExecuteServiceArgumentValue[] = []
    for (const arg of service.args) {
      const value = args[arg.name]
      const encoded = value === undefined ? null : toWireArg(arg.type, value)
      if (encoded === null) {
        throw new EspServiceError(
          'bad-argument',
          `argument '${arg.name}' of '${name}' must be ${arg.type}`,
        )
      }
      wire.push(encoded)
    }
    try {
      this.client.services.execute(service.key, wire)
    } catch (err: unknown) {
      throw new EspServiceError('send-failed', safeMessage(err))
    }
  }

  async close(): Promise<void> {
    this.closedByUs = true
    try {
      await this.client[Symbol.asyncDispose]()
    } finally {
      this.finish(null)
    }
  }

  private finish(cause: EspLinkError | null): void {
    if (this.closed) return
    this.closed = true
    for (const disposer of this.disposers) disposer[Symbol.dispose]()
    const reported = this.closedByUs ? null : cause
    for (const handler of this.closeHandlers) handler(reported)
  }
}

/** Real factory: a plaintext session when no key is set, a Noise session otherwise. */
export const clientLinkFactory: EspLinkFactory = {
  async open(connection: Readonly<EspConnection>, signal: AbortSignal): Promise<EspLink> {
    const psk = connection.noisePsk.length > 0 ? connection.noisePsk : null
    try {
      const client = await openEspHomeClient({
        host: connection.host,
        port: connection.port,
        psk,
        reconnect: false,
        connectTimeoutMs: CONNECT_TIMEOUT_MS,
        signal,
      })
      return new ClientLink(client, psk !== null)
    } catch (err: unknown) {
      throw classifyFailure(err)
    }
  },
}
