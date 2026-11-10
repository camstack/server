/**
 * `notification-output` provider for Echo devices. Text is the rule template
 * as plain speech. A burst collapses or waits; it is not queued. A transport
 * failure is `success: false` so the notification outbox retries. A collapse,
 * a rate limit, or Do Not Disturb is a recorded skip (`success: true`) so the
 * outbox does not speak the same sentence again later.
 */
import {
  type ConfigField,
  type ConfigUISchema,
  type DiscoveredTarget,
  type INotificationOutputProvider,
  type IScopedLogger,
  linkFieldDescriptor,
  type Notification,
  type ProbeTargetConfigResult,
  type SendResult,
  type Target,
  type TargetKind,
} from '@camstack/types'
import {
  ALEXA_ACCOUNT_LINK,
  ALEXA_SPEAK_ADDON_ID,
  ALEXA_SPEAK_ICON_URL,
  ALEXA_SPEAK_KIND,
  type SpeakMode,
  SPEECH_MAX_CHARS,
} from './constants.js'
import { admitSpeech, emptySpeechLedger, type SpeechLedger } from './rate-limit.js'
import { ALEXA_SPEECH_CAPS, speechFromNotification } from './speech-text.js'
import type { EchoDevice, TargetDelivery } from './worker-protocol.js'

export type DeliveryOutcome =
  | 'spoken'
  | 'announced'
  | 'collapsed'
  | 'rate_limited'
  | 'dnd'
  | 'offline'
  | 'failed'
  | 'empty'

export interface DeliveryRecord {
  readonly targetId: string
  readonly outcome: DeliveryOutcome
  readonly at: number
  readonly error?: string
}

export interface SpeakCommand {
  readonly brokerId: string
  readonly mode: SpeakMode
  readonly targets: readonly string[]
  readonly text: string
}

/** One Amazon account (broker) as the provider sees it. */
export interface SpeakBrokerView {
  readonly id: string
  readonly name: string
  readonly ready: boolean
  readonly devices: readonly EchoDevice[]
  /** Ms epoch until which Amazon asked this account to pause (429); absent when it is free. */
  readonly rateLimitedUntil?: number | null
}

export interface AlexaSpeakPorts {
  readonly brokers: () => readonly SpeakBrokerView[]
  readonly speak: (command: SpeakCommand) => Promise<readonly TargetDelivery[]>
  readonly now: () => number
  readonly logger: IScopedLogger
  /** The targets now, read from the records on every use: an instance may have changed them. */
  readonly loadTargets: () => Promise<readonly Target[]>
}

export interface AlexaNotificationProvider extends INotificationOutputProvider {
  readonly deliveries: readonly DeliveryRecord[]
}

function quietLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return logger
    },
    withTags() {
      return logger
    },
  }
  return logger
}

/**
 * The account a target speaks through: the one it names; else the only one there is; else the one
 * whose Echoes include the target's Echo.
 */
export function pickBroker(
  brokers: readonly SpeakBrokerView[],
  config: Readonly<Record<string, unknown>>,
): SpeakBrokerView | undefined {
  const named = readString(config, 'brokerId')
  if (named.length > 0) return brokers.find((broker) => broker.id === named)
  if (brokers.length === 1) return brokers[0]
  const echoId = readString(config, 'echoId')
  const owners = brokers.filter((broker) => broker.devices.some((device) => device.id === echoId))
  return owners.length === 1 ? owners[0] : undefined
}

/**
 * The save-time rule of an Echo target: an Echo and an account must be picked, and the account is
 * pinned the moment it is known, so a second account added later cannot silently change where an
 * existing target speaks. Throws the reason; returns the keys to keep with the write.
 */
export function validateEchoTarget(
  brokers: readonly SpeakBrokerView[],
  config: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (readString(config, 'echoId').length === 0) throw new Error('Pick the Echo that should speak')
  const owner = pickBroker(brokers, config)
  if (owner === undefined) {
    const named = readString(config, 'brokerId')
    if (named.length > 0) throw new Error(`The Amazon account ${named} is not available`)
    throw new Error(
      brokers.length === 0
        ? 'Add an Amazon account first: an Echo speaks through one'
        : 'Pick the Amazon account this Echo belongs to',
    )
  }
  return readString(config, 'brokerId').length === 0 ? { brokerId: owner.id } : {}
}

function readString(config: Readonly<Record<string, unknown>>, key: string): string {
  const value = config[key]
  return typeof value === 'string' ? value : ''
}

/** The level id an Echo notification uses for "quiet: no chime, no announcement". */
const SILENT_LEVEL_ID = 'silent'
const SILENT_PRIORITY = 1

/**
 * Quiet or announce is decided PER NOTIFICATION, never per target: a silent
 * notification (the kind's silent level, or the lowest priority when no level
 * is named) is spoken quietly, hours-aware; every other one announces.
 */
function modeFor(notification: Notification): SpeakMode {
  const silent =
    notification.level !== undefined
      ? notification.level === SILENT_LEVEL_ID
      : notification.priority <= SILENT_PRIORITY
  return silent ? 'speak' : 'announce'
}

function respectDnd(config: Record<string, unknown>): boolean {
  return config['respectDnd'] !== false
}

/** "Kitchen · Living room · ECHO" — the name first, then what tells two Echoes apart. */
export function echoOptionLabel(device: EchoDevice): string {
  const kind = device.kind === 'group' ? 'Group' : device.family
  const parts = [device.name.length > 0 ? device.name : device.id]
  if (device.room !== undefined && device.room.length > 0) parts.push(device.room)
  if (kind.length > 0) parts.push(kind)
  return parts.join(' · ')
}

/**
 * The two pickers are not `required`: a required select shows its first option
 * while the form still holds no value, so a save would drop the choice. Left
 * optional they open on "Select", and `validateEchoTarget` refuses an empty pick on save.
 *
 * The account is a broker pick (existing, or created in place); the Echo list
 * is fetched from that account, so a new Echo shows up without a deploy.
 */
function configSchema(): ConfigUISchema {
  const accountFields: ConfigField[] = [
    {
      ...linkFieldDescriptor('brokerId', ALEXA_ACCOUNT_LINK, { label: 'Amazon account' }),
      labelKey: 'import-alexa:echoTarget.s_echo.brokerId.label',
    },
    {
      type: 'select',
      key: 'echoId',
      label: 'Echo',
      labelKey: 'import-alexa:echoTarget.s_echo.echoId.label',
      options: [],
      discoverOptions: { kind: ALEXA_SPEAK_KIND, dependsOn: ['brokerId'] },
    },
  ]
  return {
    sections: [
      {
        id: 'echo',
        title: 'Echo',
        titleKey: 'import-alexa:echoTarget.s_echo.title',
        fields: [
          ...accountFields,
          {
            type: 'boolean',
            key: 'respectDnd',
            label: 'Respect Do Not Disturb',
            labelKey: 'import-alexa:echoTarget.s_echo.respectDnd.label',
            default: true,
          },
        ],
      },
    ],
  }
}

/** The Alexa target kind as the Add target form sees it. */
export function alexaTargetKind(): TargetKind {
  return {
    kind: ALEXA_SPEAK_KIND,
    label: 'Alexa',
    icon: 'megaphone',
    iconUrl: ALEXA_SPEAK_ICON_URL,
    iconMediaType: 'image/svg+xml',
    addonId: ALEXA_SPEAK_ADDON_ID,
    supportsDiscovery: true,
    destinationKeys: ['brokerId', 'echoId'],
    configSchema: configSchema(),
    caps: {
      // An Echo speaks the TITLE and nothing else (#483, operator 2026-11-10):
      // the dispatcher drops the body and the rule editor offers only a title.
      text: ALEXA_SPEECH_CAPS.text,
      attachments: { mediaTypes: [], mode: 'url', max: 0 },
      actions: 0,
      actionIcons: false,
      levels: [
        {
          id: SILENT_LEVEL_ID,
          label: 'Silent',
          ordinal: SILENT_PRIORITY,
          flags: { silent: true },
          description: 'Spoken quietly: no chime, quiet hours apply.',
        },
        {
          id: 'default',
          label: 'Announce',
          ordinal: 3,
          description: 'Announced: chime, then speech.',
        },
      ],
      format: ['text'],
      clickUrl: false,
      sound: false,
      ttl: false,
      bodyMaxLen: SPEECH_MAX_CHARS,
    },
  }
}

function discoveredFrom(broker: SpeakBrokerView, device: EchoDevice): DiscoveredTarget {
  return {
    kind: ALEXA_SPEAK_KIND,
    suggestedName: device.name.length > 0 ? device.name : device.id,
    config: {
      brokerId: broker.id,
      echoId: device.id,
      respectDnd: true,
      family: device.family,
      deviceKind: device.kind,
    },
  }
}

export function createAlexaNotificationProvider(ports: AlexaSpeakPorts): AlexaNotificationProvider {
  const logger = ports.logger ?? quietLogger()
  let ledger: SpeechLedger = emptySpeechLedger()
  let deliveries: readonly DeliveryRecord[] = []

  function record(row: DeliveryRecord): void {
    deliveries = [...deliveries, row]
  }

  function brokerFor(config: Record<string, unknown>): SpeakBrokerView | undefined {
    return pickBroker(ports.brokers(), config)
  }

  async function deliver(target: Target, notification: Notification): Promise<SendResult> {
    const speech = speechFromNotification(notification)
    const echoId = readString(target.config, 'echoId')
    const deviceId = notification.deviceId
    const tags = deviceId !== undefined ? { tags: { deviceId } } : {}
    if (echoId.length === 0) {
      record({
        targetId: target.id,
        outcome: 'failed',
        at: ports.now(),
        error: 'target has no echo id',
      })
      logger.warn('alexa speak dropped: target has no echo id', {
        ...tags,
        meta: { targetId: target.id },
      })
      return { success: false, error: 'target has no echo id', renderedAs: speech.renderedAs }
    }
    if (speech.text.length === 0) {
      record({ targetId: target.id, outcome: 'empty', at: ports.now() })
      logger.info('alexa speak dropped: empty text', {
        ...tags,
        meta: { targetId: target.id, echoId },
      })
      return { success: true, renderedAs: speech.renderedAs }
    }
    const broker = brokerFor(target.config)
    if (broker === undefined) {
      const error = 'target has no Amazon account'
      record({ targetId: target.id, outcome: 'failed', at: ports.now(), error })
      logger.warn('alexa speak dropped: target names no Amazon account', {
        ...tags,
        meta: { targetId: target.id, echoId },
      })
      return { success: false, error, renderedAs: speech.renderedAs }
    }
    const device = broker.devices.find((row) => row.id === echoId)
    if (device !== undefined && respectDnd(target.config) && device.dnd) {
      record({ targetId: target.id, outcome: 'dnd', at: ports.now() })
      logger.info('alexa speak skipped: do not disturb', {
        ...tags,
        meta: { targetId: target.id, echoId },
      })
      return { success: true, renderedAs: speech.renderedAs }
    }
    if (device !== undefined && !device.online) {
      record({ targetId: target.id, outcome: 'offline', at: ports.now() })
      logger.info('alexa speak not delivered: echo offline', {
        ...tags,
        meta: { targetId: target.id, echoId },
      })
      return { success: false, error: 'echo offline', renderedAs: speech.renderedAs }
    }
    const admitted = admitSpeech(ledger, echoId, speech.text, ports.now())
    ledger = admitted.ledger
    if (admitted.decision !== 'admit') {
      record({ targetId: target.id, outcome: admitted.decision, at: ports.now() })
      logger.info('alexa speak skipped', {
        ...tags,
        meta: { targetId: target.id, echoId, outcome: admitted.decision },
      })
      return { success: true, renderedAs: speech.renderedAs }
    }
    const mode = modeFor(notification)
    try {
      const outcomes = await ports.speak({
        brokerId: broker.id,
        mode,
        targets: [echoId],
        text: speech.text,
      })
      const one = outcomes.find((row) => row.targetId === echoId) ?? outcomes[0]
      if (one === undefined || !one.ok) {
        const error = one?.error ?? 'speak failed'
        record({ targetId: target.id, outcome: 'failed', at: ports.now(), error })
        logger.warn('alexa speak failed', { ...tags, meta: { targetId: target.id, echoId, error } })
        return { success: false, error, renderedAs: speech.renderedAs }
      }
      const outcome: DeliveryOutcome = mode === 'announce' ? 'announced' : 'spoken'
      record({ targetId: target.id, outcome, at: ports.now() })
      logger.info('alexa speak delivered', {
        ...tags,
        meta: { targetId: target.id, echoId, outcome },
      })
      return { success: true, renderedAs: speech.renderedAs }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      record({ targetId: target.id, outcome: 'failed', at: ports.now(), error })
      logger.warn('alexa speak failed', { ...tags, meta: { targetId: target.id, echoId, error } })
      return { success: false, error, renderedAs: speech.renderedAs }
    }
  }

  return {
    get deliveries(): readonly DeliveryRecord[] {
      return deliveries
    },
    async listTargetKinds() {
      return [alexaTargetKind()]
    },
    async discoverTargets(input) {
      // The cap has no field to say "not ready", so an empty list would read as "no Echo":
      // say which accounts are the reason, on the record.
      for (const broker of ports.brokers()) {
        if (!broker.ready) {
          ports.logger.warn(
            `alexa echo discovery: no Echo listed for '${broker.name}', the Amazon account is not signed in for this broker`,
            { tags: { brokerId: broker.id } },
          )
        }
      }
      // The form names an account: every Echo of it, labelled to tell two apart.
      const named = readString(input.config ?? {}, 'brokerId')
      if (named.length > 0) {
        const owner = ports.brokers().find((broker) => broker.id === named)
        return (owner?.devices ?? []).map((device) => ({
          ...discoveredFrom(owner ?? { id: named, name: named, ready: false, devices: [] }, device),
          suggestedName: echoOptionLabel(device),
        }))
      }
      // Otherwise one proposal per Echo that no saved target already speaks on.
      const taken = new Set(
        (await ports.loadTargets()).flatMap((row) => {
          const owner = brokerFor(row.config)
          return owner === undefined ? [] : [`${owner.id}/${readString(row.config, 'echoId')}`]
        }),
      )
      return ports
        .brokers()
        .flatMap((broker) =>
          broker.devices
            .filter((device) => !taken.has(`${broker.id}/${device.id}`))
            .map((device) => discoveredFrom(broker, device)),
        )
    },
    async probeTargetConfig(input) {
      const broker = brokerFor(input.config)
      const result: ProbeTargetConfigResult =
        broker !== undefined && broker.ready
          ? { ok: true, resolvedUrl: 'alexa://session' }
          : {
              ok: false,
              resolvedUrl: 'alexa://session',
              error: 'the Amazon account is not signed in on its broker',
            }
      return result
    },
    async send(input) {
      const target = (await ports.loadTargets()).find((row) => row.id === input.targetId)
      if (target === undefined)
        return { success: false, error: `target not found: ${input.targetId}` }
      if (!target.enabled) return { success: false, error: 'target disabled' }
      return deliver(target, input.notification)
    },
    async testTarget(input) {
      const found = (await ports.loadTargets()).find((row) => row.id === input.targetId)
      if (found === undefined)
        return { success: false, error: `target not found: ${input.targetId}` }
      if (!found.enabled) return { success: false, error: 'target disabled' }
      const sample: Notification = input.sample ?? {
        body: 'This is a CamStack test notification.',
        title: 'CamStack',
        format: 'text',
        priority: 3,
      }
      return deliver(found, sample)
    },
  }
}
