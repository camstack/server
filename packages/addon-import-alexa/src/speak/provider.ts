/**
 * `notification-output` provider for Echo devices. Text is the rule template
 * as plain speech. A burst collapses or waits; it is not queued. A transport
 * failure is `success: false` so the notification outbox retries. A collapse,
 * a rate limit, or Do Not Disturb is a recorded skip (`success: true`) so the
 * outbox does not speak the same sentence again later.
 */
import {
  type ConfigUISchema,
  type DiscoveredTarget,
  type INotificationOutputProvider,
  type IScopedLogger,
  type Notification,
  type ProbeTargetConfigResult,
  type SendResult,
  type Target,
  type TargetKind,
} from '@camstack/types'
import {
  ALEXA_SPEAK_ADDON_ID,
  ALEXA_SPEAK_KIND,
  type SpeakMode,
  SPEECH_MAX_CHARS,
} from './constants.js'
import { admitSpeech, emptySpeechLedger, type SpeechLedger } from './rate-limit.js'
import { speechFromNotification } from './speech-text.js'
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
  readonly mode: SpeakMode
  readonly targets: readonly string[]
  readonly text: string
  readonly volume: number
}

export interface AlexaSpeakPorts {
  readonly devices: () => readonly EchoDevice[]
  readonly speak: (command: SpeakCommand) => Promise<readonly TargetDelivery[]>
  readonly loggedIn: () => boolean
  readonly now: () => number
  readonly logger: IScopedLogger
  readonly loadTargets: () => readonly Target[]
  readonly saveTargets: (targets: readonly Target[]) => void
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

function readString(config: Record<string, unknown>, key: string): string {
  const value = config[key]
  return typeof value === 'string' ? value : ''
}

function readMode(config: Record<string, unknown>): SpeakMode {
  return config['mode'] === 'announce' ? 'announce' : 'speak'
}

function readVolume(config: Record<string, unknown>): number {
  const value = config['volume']
  if (typeof value !== 'number' || !Number.isFinite(value)) return 40
  return Math.max(0, Math.min(100, Math.round(value)))
}

function respectDnd(config: Record<string, unknown>): boolean {
  return config['respectDnd'] !== false
}

function configSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'echo',
        title: 'Echo',
        titleKey: 'import-alexa:echoTarget.s_echo.title',
        fields: [
          {
            type: 'text',
            key: 'echoId',
            label: 'Echo id',
            labelKey: 'import-alexa:echoTarget.s_echo.echoId.label',
            required: true,
          },
          {
            type: 'select',
            key: 'mode',
            label: 'Mode',
            labelKey: 'import-alexa:echoTarget.s_echo.mode.label',
            default: 'speak',
            options: [
              { value: 'speak', label: 'Speak (quiet hours apply)' },
              { value: 'announce', label: 'Announce (chime, then speech)' },
            ],
          },
          {
            type: 'number',
            key: 'volume',
            label: 'Volume',
            labelKey: 'import-alexa:echoTarget.s_echo.volume.label',
            min: 0,
            max: 100,
            default: 40,
          },
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

function kindDescriptor(): TargetKind {
  return {
    kind: ALEXA_SPEAK_KIND,
    label: 'Alexa',
    icon: 'megaphone',
    addonId: ALEXA_SPEAK_ADDON_ID,
    supportsDiscovery: true,
    destinationKeys: ['echoId'],
    configSchema: configSchema(),
    caps: {
      attachments: { mediaTypes: [], mode: 'url', max: 0 },
      actions: 0,
      actionIcons: false,
      levels: [{ id: 'default', label: 'Default', ordinal: 3 }],
      format: ['text'],
      clickUrl: false,
      sound: false,
      ttl: false,
      bodyMaxLen: SPEECH_MAX_CHARS,
    },
  }
}

function discoveredFrom(device: EchoDevice): DiscoveredTarget {
  return {
    kind: ALEXA_SPEAK_KIND,
    suggestedName: device.name.length > 0 ? device.name : device.id,
    config: {
      echoId: device.id,
      mode: 'speak',
      volume: 40,
      respectDnd: true,
      family: device.family,
      deviceKind: device.kind,
    },
  }
}

export function createAlexaNotificationProvider(ports: AlexaSpeakPorts): AlexaNotificationProvider {
  const logger = ports.logger ?? quietLogger()
  let targets: readonly Target[] = ports.loadTargets()
  let ledger: SpeechLedger = emptySpeechLedger()
  let deliveries: readonly DeliveryRecord[] = []

  function record(row: DeliveryRecord): void {
    deliveries = [...deliveries, row]
  }

  function deviceFor(echoId: string): EchoDevice | undefined {
    return ports.devices().find((device) => device.id === echoId)
  }

  function persist(next: readonly Target[]): void {
    targets = next
    ports.saveTargets(next)
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
    const device = deviceFor(echoId)
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
    const mode = readMode(target.config)
    try {
      const outcomes = await ports.speak({
        mode,
        targets: [echoId],
        text: speech.text,
        volume: readVolume(target.config),
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
      return [kindDescriptor()]
    },
    async listTargets() {
      return [...targets]
    },
    async getTarget(input) {
      const found = targets.find((target) => target.id === input.targetId)
      if (found === undefined) throw new Error(`target not found: ${input.targetId}`)
      return found
    },
    async discoverTargets() {
      return ports.devices().map(discoveredFrom)
    },
    async probeTargetConfig() {
      const result: ProbeTargetConfigResult = ports.loggedIn()
        ? { ok: true, resolvedUrl: 'alexa://session' }
        : { ok: false, resolvedUrl: 'alexa://session', error: 'not signed in' }
      return result
    },
    async send(input) {
      const target = targets.find((row) => row.id === input.targetId)
      if (target === undefined)
        return { success: false, error: `target not found: ${input.targetId}` }
      if (!target.enabled) return { success: false, error: 'target disabled' }
      return deliver(target, input.notification)
    },
    async testTarget(input) {
      const found = targets.find((row) => row.id === input.targetId)
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
    async upsertTarget(input) {
      const target: Target = {
        ...input.target,
        addonId: ALEXA_SPEAK_ADDON_ID,
        kind: ALEXA_SPEAK_KIND,
      }
      const rest = targets.filter((row) => row.id !== target.id)
      persist([...rest, target])
      return target
    },
    async deleteTarget(input) {
      persist(targets.filter((row) => row.id !== input.targetId))
    },
    async setTargetEnabled(input) {
      persist(
        targets.map((row) =>
          row.id === input.targetId ? { ...row, enabled: input.enabled } : row,
        ),
      )
    },
  }
}
