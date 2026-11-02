/**
 * The Reolink side of the `smtp-inbound` broker kind (D999).
 *
 * Battery cameras report motion by mail. The mailbox they mail is a `broker` of kind
 * `smtp-inbound` owned by `smtp-nodemailer`; this bridge
 *   - creates it on first need (`ensureMailbox`: one in-process promise, adopt-id, never at a bare boot),
 *   - declares the `cam-<stableId>` recipients of the standalone cameras (`sync`),
 *   - turns each `broker.message` into the camera's `handleSimpleEvent({ source: 'email' })`,
 *   - replays what the bus lost from the broker's ring (seq gap, a broker that came back, subscribe).
 * It never deletes the mailbox: the operator owns it, and the bridge recreates it at the next need.
 * Events are telemetry (D8); the ring is the RPC reconcile.
 */
import { classifyEmailPushMessage } from '@apocaliss92/nodelink-js'
import {
  type AddonContext,
  type IScopedLogger,
  SMTP_INBOUND_DEFAULT_ID,
  SMTP_INBOUND_KIND,
  SmtpInboundConfigSchema,
  type SmtpInboundMessage,
  type SmtpInboundSettings,
  SmtpInboundMessageSchema,
  SmtpInboundSinceSchema,
  smtpSinceKey,
} from '@camstack/types'
import { z } from 'zod'
import {
  type EmailPushManagerSetupParams,
  type EmailPushSimpleEventType,
  mapInferredTypeToSimpleEvents,
} from './email-push-shared.js'

/** The addon that owns `smtp-inbound` mailboxes: routes the id-less calls (`add`). */
export const SMTP_BROKER_ADDON_ID = 'smtp-nodemailer'
/** Who this addon is, among the subscribers of a mailbox. */
export const REOLINK_SUBSCRIBER_ID = 'provider-reolink'
const MAILBOX_NAME = 'Camera mailbox'
const RECIPIENT_PREFIX = 'cam-'

/** What the bridge needs of a camera. */
export interface BridgeCamera {
  readonly id: number
  readonly stableId: string
  readonly isEmailPushEligible: boolean
  readonly emailPushChannel: number
  handleSimpleEvent(event: {
    readonly type: EmailPushSimpleEventType
    readonly channel: number
    readonly timestamp: number
    readonly source: 'email'
  }): void
}

/** The broker cap, narrowed to the calls the bridge makes (a spec fakes it). */
export interface BrokerPort {
  list(): Promise<readonly { readonly id: string }[]>
  add(input: { readonly id: string; readonly name: string }): Promise<{ readonly id: string }>
  getBrokerConfig(id: string): Promise<unknown>
  subscribe(id: string, recipients: readonly string[]): Promise<{ readonly subscriptionId: string }>
  unsubscribe(id: string, subscriptionId: string): Promise<void>
  getState(id: string, key: string): Promise<unknown>
}

/** The real port: `ctx.api.broker`, every call routed to the addon that owns the kind. */
export function createBrokerPort(api: AddonContext['api']): BrokerPort {
  const route = { addonId: SMTP_BROKER_ADDON_ID }
  return {
    list: async () => api.broker.list.query({ kind: SMTP_INBOUND_KIND }),
    add: async ({ id, name }) =>
      api.broker.add.mutate({ kind: SMTP_INBOUND_KIND, name, id, settings: {}, ...route }),
    getBrokerConfig: async (id) => api.broker.getBrokerConfig.query({ id, ...route }),
    subscribe: async (brokerId, recipients) =>
      api.broker.subscribe.mutate({
        brokerId,
        filter: { recipients: [...recipients], subscriberId: REOLINK_SUBSCRIBER_ID },
        ...route,
      }),
    unsubscribe: async (brokerId, subscriptionId) =>
      api.broker.unsubscribe.mutate({ brokerId, subscriptionId, ...route }),
    getState: async (brokerId, key) => api.broker.getState.query({ brokerId, key, ...route }),
  }
}

/**
 * Create the default mailbox with the settings the cameras already use (the migration).
 * `exists` when the id is taken: the operator's mailbox is never replaced.
 */
export async function addMailboxWithSettings(
  api: AddonContext['api'],
  settings: Partial<SmtpInboundSettings>,
): Promise<'created' | 'exists'> {
  try {
    await api.broker.add.mutate({
      kind: SMTP_INBOUND_KIND,
      name: MAILBOX_NAME,
      id: SMTP_INBOUND_DEFAULT_ID,
      settings: { ...settings },
      addonId: SMTP_BROKER_ADDON_ID,
    })
    return 'created'
  } catch (err: unknown) {
    if (isInUse(err)) return 'exists'
    throw err
  }
}

export interface EmailPushBridgeDeps {
  readonly port: BrokerPort
  readonly listCameras: () => readonly BridgeCamera[]
  readonly logger: IScopedLogger
}

const BrokerMessageEventSchema = z.object({
  brokerId: z.string(),
  subscriptionId: z.string(),
  key: z.string(),
  payload: z.unknown(),
})
const BrokerStatusEventSchema = z.object({
  brokerId: z.string(),
  status: z.string(),
  error: z.string().optional(),
})

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isInUse(err: unknown): boolean {
  return /already in use/i.test(errMsg(err))
}

export class EmailPushBridge {
  private mailbox: Promise<string> | null = null
  private brokerId: string | null = null
  private subscriptionId: string | null = null
  /** The recipient set the broker holds for this addon, as a key. */
  private declared: string | null = null
  private lastSeq = 0
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly deps: EmailPushBridgeDeps) {}

  // ── the mailbox ───────────────────────────────────────────────────────────

  /** The id of the mailbox, creating it when none exists. One in-flight promise. */
  ensureMailbox(): Promise<string> {
    this.mailbox ??= this.findOrCreate().catch((err: unknown) => {
      this.mailbox = null
      throw err
    })
    return this.mailbox
  }

  private async findOrCreate(): Promise<string> {
    const existing = await this.deps.port.list()
    const found = pickMailbox(existing)
    if (found !== null) return found
    try {
      const created = await this.deps.port.add({ id: SMTP_INBOUND_DEFAULT_ID, name: MAILBOX_NAME })
      this.deps.logger.info('email-push: created the camera mailbox', {
        meta: { brokerId: created.id },
      })
      return created.id
    } catch (err: unknown) {
      if (!isInUse(err)) throw err
      // Someone created it between our list and our add: read it again.
      const again = pickMailbox(await this.deps.port.list())
      if (again === null) throw err
      return again
    }
  }

  // ── the recipients ────────────────────────────────────────────────────────

  private recipients(): readonly string[] {
    return this.deps
      .listCameras()
      .filter((cam) => cam.isEmailPushEligible)
      .map((cam) => `${RECIPIENT_PREFIX}${cam.stableId}`)
      .sort()
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job)
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * Declare the recipients of the eligible cameras (again). Cheap when nothing changed.
   * A failure is logged, never thrown: a camera that cannot be declared does not stop the addon.
   */
  sync(options: { readonly force?: boolean } = {}): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.doSync(options.force === true)
      } catch (err: unknown) {
        this.deps.logger.error('email-push: could not declare the camera recipients', {
          meta: { error: errMsg(err) },
        })
      }
    })
  }

  private async doSync(force: boolean): Promise<void> {
    const recipients = this.recipients()
    if (recipients.length === 0) {
      // No camera needs a mailbox: give back what we hold; never create one for nothing.
      if (this.brokerId !== null && this.subscriptionId !== null) {
        await this.deps.port.unsubscribe(this.brokerId, this.subscriptionId)
      }
      this.subscriptionId = null
      this.declared = null
      return
    }
    const key = recipients.join(',')
    if (!force && this.declared === key && this.subscriptionId !== null) return
    const brokerId = await this.ensureMailbox()
    const { subscriptionId } = await this.deps.port.subscribe(brokerId, recipients)
    this.brokerId = brokerId
    this.subscriptionId = subscriptionId
    this.declared = key
    await this.reconcile()
  }

  // ── messages ──────────────────────────────────────────────────────────────

  /** A `broker.message` event off the bus. */
  onMessage(raw: unknown): Promise<void> {
    return this.enqueue(async () => {
      const event = BrokerMessageEventSchema.safeParse(raw)
      if (!event.success || event.data.brokerId !== this.brokerId) return
      const message = SmtpInboundMessageSchema.safeParse(event.data.payload)
      if (!message.success) {
        this.deps.logger.warn('email-push: a mailbox message did not parse — dropped', {
          meta: { key: event.data.key },
        })
        return
      }
      if (message.data.seq <= this.lastSeq) return
      if (message.data.seq > this.lastSeq + 1) {
        // The bus lost one or more: the ring has them, in order, this one included.
        await this.reconcile()
        return
      }
      this.process(event.data.key, message.data)
    })
  }

  /** A `broker.status-changed` event: a mailbox that came back has forgotten its subscriptions. */
  onStatusChanged(raw: unknown): Promise<void> {
    const event = BrokerStatusEventSchema.safeParse(raw)
    if (!event.success || event.data.brokerId !== this.brokerId) return Promise.resolve()
    if (event.data.status !== 'connected') {
      this.deps.logger.warn('email-push: the camera mailbox is not connected', {
        meta: { status: event.data.status, error: event.data.error },
      })
      return Promise.resolve()
    }
    return this.sync({ force: true })
  }

  /** Replay what the ring holds after the last seq we processed. */
  private async reconcile(): Promise<void> {
    if (this.brokerId === null) return
    let since = await this.readSince(this.lastSeq)
    if (since !== null && since.lastSeq < this.lastSeq) {
      // The mailbox's seq went back: it restarted. Its ring is a new one.
      this.lastSeq = 0
      since = await this.readSince(0)
    }
    if (since === null) return
    for (const entry of since.messages) this.process(entry.key, entry.message)
  }

  private async readSince(seq: number) {
    const id = this.brokerId
    if (id === null) return null
    try {
      const raw = await this.deps.port.getState(id, smtpSinceKey(seq))
      const parsed = SmtpInboundSinceSchema.safeParse(raw)
      if (parsed.success) return parsed.data
      this.deps.logger.warn('email-push: the mailbox replay did not parse', {
        meta: { brokerId: id },
      })
    } catch (err: unknown) {
      // A failed read changes nothing: the next event or status change reconciles again.
      this.deps.logger.warn('email-push: the mailbox replay could not be read', {
        meta: { brokerId: id, error: errMsg(err) },
      })
    }
    return null
  }

  private process(key: string, message: SmtpInboundMessage): void {
    if (message.seq <= this.lastSeq) return
    this.lastSeq = message.seq
    const cam = this.deps.listCameras().find((c) => `${RECIPIENT_PREFIX}${c.stableId}` === key)
    if (cam === undefined) {
      this.deps.logger.warn('email-push: mail for an unknown camera — dropping', {
        meta: { key, seq: message.seq },
      })
      return
    }
    const inferred = classifyEmailPushMessage({ subject: message.subject, text: message.text })
    this.deps.logger.info('email-push: motion received from battery camera', {
      tags: { deviceId: cam.id },
      meta: { inferredType: inferred, subject: message.subject.slice(0, 80), seq: message.seq },
    })
    // One mail can owe the camera more than one event (see `mapInferredTypeToSimpleEvents`).
    for (const type of mapInferredTypeToSimpleEvents(inferred)) {
      cam.handleSimpleEvent({
        type,
        channel: cam.emailPushChannel,
        timestamp: message.receivedAt,
        source: 'email',
      })
    }
  }

  // ── what a camera is told ─────────────────────────────────────────────────

  /**
   * What a camera needs to mail the mailbox. `null` for a camera that cannot do email push.
   * Throws the reason when the hub has no internal address: there is no fallback host.
   */
  async buildCameraSetupParams(cam: BridgeCamera): Promise<EmailPushManagerSetupParams | null> {
    if (!cam.isEmailPushEligible) return null
    const brokerId = await this.ensureMailbox()
    const parsed = SmtpInboundConfigSchema.safeParse(await this.deps.port.getBrokerConfig(brokerId))
    if (!parsed.success)
      throw new Error('The camera mailbox answered a configuration this build cannot read')
    const config = parsed.data
    if (config.host === null) {
      throw new Error(config.hostReason ?? 'The hub has no internal address (System → Network)')
    }
    // The camera sends to a recipient this addon holds; declare it before the camera is pointed here.
    await this.sync()
    return {
      managerHost: config.host,
      managerPort: config.port,
      domain: config.domain,
      recipientLocalPart: `${RECIPIENT_PREFIX}${cam.stableId}`,
      ...(config.requireAuth
        ? { authUsername: config.username, authPassword: config.password }
        : {}),
    }
  }
}

function pickMailbox(list: readonly { readonly id: string }[]): string | null {
  const preferred = list.find((b) => b.id === SMTP_INBOUND_DEFAULT_ID)
  return preferred?.id ?? list[0]?.id ?? null
}
