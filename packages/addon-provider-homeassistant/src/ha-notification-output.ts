/**
 * `homeassistant` notification-output kind — hosted BY the HA provider addon.
 *
 * A SECOND `notification-output` collection provider (the first lives in the
 * system `addon-notifiers`). The generated cap-mount `concatCollection`-fans
 * `listTargetKinds` / `listTargets` / `discoverTargets` across every registered
 * provider, and routes `send` / `testTarget` / CRUD to ONE provider by the
 * `addonId` stamped on each kind + target. So the HA addon contributes exactly
 * one kind (`homeassistant`) to the shared catalog.
 *
 * Why a local, self-contained implementation? Addons may not cross-import, so
 * this cannot reuse `addon-notifiers`' provider/adapter/TargetStore code. Only
 * `@camstack/types` is shared (the cap schema + the pure `prepareNotification`
 * degrade engine). Everything else here (`HaTargetStore`, the settings-store
 * port, the payload builder, the discovery parser) is a small local copy.
 *
 * Delivery reuses the HA broker WebSocket: `send` degrades the canonical
 * notification for the kind's caps, builds a `notify.<service>` `call_service`
 * payload (`buildNotifyServiceData`), and `publish`es it over the broker WS.
 * `discoverTargets` issues a `get_services` WS message and turns every
 * `notify.*` service into a candidate.
 *
 * The notify `service_data`/`data` mapping is the battle-tested minimal
 * shape: image URL in `data.image`, iOS critical via
 * `data.push['interruption-level']='critical'`, Android priority via
 * `data.priority='high'`. It extends that with the per-level Android
 * `importance` + iOS interruption-level gradation and the HA Companion
 * actionable-notification `actions:[{action,title,uri}]` block (the action
 * id round-trips as the `mobile_app_notification_action` event).
 */
import {
  type ConfigUISchema,
  type DiscoveredTarget,
  errMsg,
  type INotificationOutputProvider,
  type IScopedLogger,
  type Notification,
  type NotificationActionIcon,
  type PreparedNotification,
  prepareNotification,
  type PublicEndpointReader,
  type RecordKindHandle,
  type RecordsAccess,
  resolveAttachmentUrls,
  type ResolvedLevel,
  type SendResult,
  type Target,
  type TargetKind,
  TargetSchema,
} from '@camstack/types'
import { HA_BROKER_KIND } from './ha-broker-source.js'
import { haRecordKinds, type HaTargetBody } from './record-kinds.js'

/** The single kind this provider contributes to the shared catalog. */
export const HA_NOTIFICATION_KIND = 'homeassistant'

/** addonId-namespaced settings-store collection holding HA notify targets. */
export const HA_TARGETS_COLLECTION = 'provider-homeassistant:ha-notification-targets'

// ── Descriptor ───────────────────────────────────────────────────────

function haConfigSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'connection',
        title: 'Home Assistant notify',
        titleKey: 'provider-homeassistant:haConfig.s_connection.title',
        fields: [
          {
            type: 'broker-select',
            key: 'brokerId',
            label: 'Broker',
            labelKey: 'provider-homeassistant:haConfig.s_connection.brokerId.label',
            description: 'The Home Assistant connection the notification goes through.',
            descriptionKey: 'provider-homeassistant:haConfig.s_connection.brokerId.description',
            brokerKind: HA_BROKER_KIND,
          },
          {
            type: 'select',
            key: 'service',
            label: 'Notify service',
            labelKey: 'provider-homeassistant:haConfig.s_connection.service.label',
            required: true,
            options: [],
            placeholder: 'mobile_app_pixel_7',
            description:
              'Loaded from the broker once it is picked. If the list does not load, type the part after `notify.`.',
            descriptionKey: 'provider-homeassistant:haConfig.s_connection.service.description',
            discoverOptions: { kind: HA_NOTIFICATION_KIND, dependsOn: ['brokerId'] },
          },
        ],
      },
    ],
  }
}

/**
 * The `homeassistant` kind descriptor. `addonId` is the owning HA addon id so
 * the concat-fanned catalog routes id-keyed calls back to THIS provider.
 */
export function homeassistantTargetKind(addonId: string): TargetKind {
  return {
    kind: HA_NOTIFICATION_KIND,
    label: 'Home Assistant',
    icon: 'home',
    addonId,
    configSchema: haConfigSchema(),
    supportsDiscovery: true,
    caps: {
      // HA Companion push accepts one media URL per notification.
      attachments: { mediaTypes: ['image', 'video', 'audio', 'icon'], mode: 'url', max: 1 },
      // Android Companion caps actionable notifications at 3 buttons.
      actions: 3,
      actionIcons: true,
      levels: [
        {
          id: 'default',
          label: 'Default',
          ordinal: 3,
          description: 'Standard push (iOS active / Android default importance).',
        },
        {
          id: 'high',
          label: 'High',
          ordinal: 4,
          description: 'iOS time-sensitive / Android high importance.',
        },
        {
          id: 'critical',
          label: 'Critical',
          ordinal: 5,
          flags: { critical: true },
          description:
            'iOS critical interruption-level (bypasses silent/DND) + Android high importance.',
        },
      ],
      // Push notifications are plain text (markdown only renders on
      // `persistent_notification`, not the mobile push).
      format: ['text'],
      clickUrl: true,
      sound: true,
      ttl: true,
      bodyMaxLen: 3500,
    },
  }
}

// ── Notify `service_data` builder (PURE) ─────────────────────────────

/** The `call_service` `service_data` for a `notify.<service>` call. */
export interface NotifyServiceData {
  readonly message: string
  readonly title?: string
  readonly data: Record<string, unknown>
}

/**
 * Map a resolved level onto the HA Companion `data` gradation:
 *   - Android: `importance` (default|high) + `priority` (high on high/critical).
 *   - iOS: `push['interruption-level']` (active|time-sensitive|critical).
 * The baseline is priority:'high' + push interruption-level 'critical' for
 * critical, extended with the per-level importance/interruption gradation.
 */
function applyLevel(data: Record<string, unknown>, level: ResolvedLevel | null): void {
  const isCritical = level?.flags?.critical === true || level?.id === 'critical'
  const isHigh = !isCritical && (level?.id === 'high' || (level?.ordinal ?? 0) >= 4)
  const push: Record<string, unknown> = {}
  if (isCritical) {
    data['importance'] = 'high'
    data['priority'] = 'high'
    push['interruption-level'] = 'critical'
  } else if (isHigh) {
    data['importance'] = 'high'
    data['priority'] = 'high'
    push['interruption-level'] = 'time-sensitive'
  } else {
    data['importance'] = 'default'
    push['interruption-level'] = 'active'
  }
  data['push'] = push
}

// The canonical icon vocabulary, in Material Design names.
//
// `mdi:` is the ANDROID Companion's icon set. iOS reads the same `icon` field
// but expects `sfsymbols:`, and the field holds one string — so this renders
// on Android and is ignored on iOS rather than rendering wrong. Declared
// `actionIcons: true` on that basis: a silently-ignored icon on one platform
// is a cosmetic loss, whereas declaring `false` would strip it for everyone
// including the Android phones that do render it.
//
// A Record over the closed enum, NOT a lookup with a fallback: adding a
// vocabulary member without deciding its glyph then fails the build here,
// which is the only place that decision can be made honestly.
const HA_ACTION_ICONS: Record<NotificationActionIcon, string> = {
  acknowledge: 'mdi:check',
  dismiss: 'mdi:close',
  silence: 'mdi:bell-off',
  snooze: 'mdi:bell-sleep',
  view: 'mdi:eye',
  play: 'mdi:play',
  open: 'mdi:door-open',
  close: 'mdi:door-closed',
  lock: 'mdi:lock',
  unlock: 'mdi:lock-open',
  arm: 'mdi:shield-check',
  'arm-home': 'mdi:shield-home',
  'arm-away': 'mdi:shield-lock',
  'arm-night': 'mdi:shield-moon',
  disarm: 'mdi:shield-off',
  light: 'mdi:lightbulb',
  alert: 'mdi:alert',
  camera: 'mdi:cctv',
}

/**
 * Build the `notify.<service>` `service_data` from a prepared (degraded)
 * notification. PURE — no WS, unit-testable in isolation.
 */
export function buildNotifyServiceData(prepared: PreparedNotification): NotifyServiceData {
  const data: Record<string, unknown> = {}

  // Attachments — first URL per media type (caps cap to max:1, url mode).
  for (const att of prepared.attachments) {
    if (att.url === undefined) continue
    if (att.mediaType === 'image' && data['image'] === undefined) data['image'] = att.url
    else if (att.mediaType === 'video' && data['video'] === undefined) data['video'] = att.url
    else if (att.mediaType === 'audio' && data['audio'] === undefined) data['audio'] = att.url
    else if (att.mediaType === 'icon' && data['notification_icon'] === undefined)
      data['notification_icon'] = att.url
  }

  // Actionable notifications — the action id round-trips as the
  // `mobile_app_notification_action` bus event's `action`.
  if (prepared.actions.length > 0) {
    data['actions'] = prepared.actions.map((a) => ({
      action: a.id,
      title: a.label,
      ...(a.url !== undefined ? { uri: a.url } : {}),
      ...(a.icon !== undefined ? { icon: HA_ACTION_ICONS[a.icon] } : {}),
    }))
  }

  // Tap-through — iOS `url`, Android `clickAction` (both accepted by Companion).
  if (prepared.clickUrl !== null) {
    data['url'] = prepared.clickUrl
    data['clickAction'] = prepared.clickUrl
  }

  // Replace/dedup tag.
  if (prepared.tag !== null) data['tag'] = prepared.tag

  // Android time-to-live (seconds).
  if (prepared.ttl !== null) data['ttl'] = prepared.ttl

  // Sound (Android/generic; iOS critical sound is a push-object concern left
  // to HA defaults).
  if (prepared.sound !== null) data['sound'] = prepared.sound

  // Level → importance / priority / interruption-level.
  applyLevel(data, prepared.level)

  return {
    message: prepared.body,
    ...(prepared.title !== undefined ? { title: prepared.title } : {}),
    data,
  }
}

// ── Discovery parser (PURE) ──────────────────────────────────────────

/**
 * Parse a HA `get_services` result into one candidate per `notify.<service>`.
 * `get_services` returns `{ [domain]: { [service]: {...} } }`; we read the
 * `notify` domain. mobile_app_* services (rich push features) sort first.
 */
export function parseNotifyServices(
  result: unknown,
  brokerId?: string,
  deviceNames?: ReadonlyMap<string, string>,
): DiscoveredTarget[] {
  if (typeof result !== 'object' || result === null) return []
  const notify = (result as Record<string, unknown>)['notify']
  if (typeof notify !== 'object' || notify === null) return []
  const entries = Object.entries(notify as Record<string, unknown>)
  const sorted = [...entries].sort(([a], [b]) => {
    const am = a.startsWith('mobile_app_') ? 0 : 1
    const bm = b.startsWith('mobile_app_') ? 0 : 1
    if (am !== bm) return am - bm
    return a.localeCompare(b)
  })
  return sorted.map(([service, definition]) => ({
    kind: HA_NOTIFICATION_KIND,
    suggestedName: friendlyServiceName(service, definition, deviceNames),
    config: { service, ...(brokerId !== undefined ? { brokerId } : {}) },
  }))
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** `alexa_media_echo` -> `Alexa Media Echo`. */
function prettifyServiceId(service: string): string {
  return service
    .split('_')
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * The name an operator recognises: the device name for a mobile app, else the
 * service's own `name`, else its `description`, else the prettified id.
 */
function friendlyServiceName(
  service: string,
  definition: unknown,
  deviceNames: ReadonlyMap<string, string> | undefined,
): string {
  const device = deviceNames?.get(service)
  if (device !== undefined) return device
  if (typeof definition === 'object' && definition !== null) {
    const fields: Record<string, unknown> = { ...definition }
    const name = nonEmptyText(fields['name'])
    if (name !== undefined) return name
    const description = nonEmptyText(fields['description'])
    if (description !== undefined) return description
  }
  return prettifyServiceId(service)
}

/** HA's slug of a device name, as it appears in `mobile_app_<slug>`. */
function slugifyDeviceName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/**
 * `mobile_app_<slug>` -> device name, read from a `config/device_registry/list`
 * reply. Only devices of the mobile_app integration count; the name the user
 * gave wins over the one the app reported.
 */
export function mobileAppDeviceNames(registry: unknown): Map<string, string> {
  const names = new Map<string, string>()
  if (!Array.isArray(registry)) return names
  for (const entry of registry) {
    if (typeof entry !== 'object' || entry === null) continue
    const device: Record<string, unknown> = { ...entry }
    const identifiers = device['identifiers']
    const isMobileApp =
      Array.isArray(identifiers) &&
      identifiers.some((pair) => Array.isArray(pair) && pair[0] === 'mobile_app')
    if (!isMobileApp) continue
    const name = nonEmptyText(device['name_by_user']) ?? nonEmptyText(device['name'])
    if (name === undefined) continue
    names.set(`mobile_app_${slugifyDeviceName(name)}`, name)
  }
  return names
}

// ── Target persistence (records, local copy) ─────────────────────────

/**
 * CRUD over the `ha-notification-targets` record kind.
 *
 * `HaTargetStore.of(records)` is the production factory; the test helper
 * (`makeFakeHaRecords`) supplies a fake transport so nothing hits SQLite.
 * No `init()` method: kinds are declared at addon boot via
 * `ctx.records.declare(haRecordKinds)`.
 */
export class HaTargetStore {
  private readonly kind: RecordKindHandle<HaTargetBody>

  constructor(kind: RecordKindHandle<HaTargetBody>) {
    this.kind = kind
  }

  /** Factory: build from a declared `RecordsAccess` (after `ctx.records.declare`). */
  static of(records: Pick<RecordsAccess, 'kind'>): HaTargetStore {
    return new HaTargetStore(records.kind(haRecordKinds['ha-notification-targets']))
  }

  async list(): Promise<Target[]> {
    const page = await this.kind.query({ limit: 1000 })
    const out: Target[] = []
    for (const record of page.records) {
      const parsed = TargetSchema.safeParse({ id: record.id, ...record.data })
      if (parsed.success) out.push(parsed.data)
    }
    return out
  }

  async getById(id: string): Promise<Target | null> {
    const row = await this.kind.get(id)
    if (row === null) return null
    const parsed = TargetSchema.safeParse({ id: row.id, ...row.data })
    return parsed.success ? parsed.data : null
  }

  async upsert(target: Target): Promise<void> {
    const { id, ...rest } = target
    // Validate: kind must be 'homeassistant' (the schema literal narrows it).
    const parsed = haRecordKinds['ha-notification-targets'].schema.safeParse(rest)
    if (!parsed.success) {
      throw new Error(`invalid HA target '${id}': ${parsed.error.message}`)
    }
    await this.kind.put({ id, data: parsed.data })
  }

  async delete(id: string): Promise<void> {
    await this.kind.delete(id)
  }

  async setEnabled(id: string, enabled: boolean): Promise<Target | null> {
    const target = await this.getById(id)
    if (target === null) return null
    const next: Target = { ...target, enabled }
    await this.upsert(next)
    return next
  }
}

// ── Provider ─────────────────────────────────────────────────────────

/** Dependencies for the `homeassistant` notification-output provider. */
export interface HaNotificationOutputDeps {
  /**
   * Reads the hub's public endpoint (`local-network` palette). A root-relative
   * attachment URL is resolved against it before it is handed to Home
   * Assistant, which would otherwise resolve it against its own base and 404.
   */
  readonly readPublicEndpoint?: PublicEndpointReader
  /** The owning HA addon id — stamped onto every kind + target for routing. */
  readonly addonId: string
  /**
   * Root-relative URL of the addon-served brand icon for the `homeassistant`
   * kind. When set, `listTargetKinds` stamps it onto the descriptor as
   * `iconUrl` so a client renders the brand mark instead of a text label.
   * Absent → no `iconUrl` is stamped.
   */
  readonly iconUrl?: string
  /**
   * Media type of {@link iconUrl}. A React-Native client renders SVG and raster
   * through different components and cannot infer the type from the URL (the
   * route path carries no extension), so the server states it. Absent → the
   * client treats the icon as raster, which for an SVG means a fallback glyph.
   */
  readonly iconMediaType?: string
  readonly store: HaTargetStore
  /** Publish a `notify.<service>` call over the resolved broker's WS. */
  readonly publish: (
    brokerId: string,
    service: string,
    serviceData: NotifyServiceData,
  ) => Promise<void>
  /** Issue a `get_services` WS message on a broker. */
  readonly getServices: (brokerId: string) => Promise<unknown>
  /** `config/device_registry/list` on a broker — names mobile apps. Optional. */
  readonly listDevices?: (brokerId: string) => Promise<unknown>
  /** Live broker ids — used to resolve the default broker + fan discovery. */
  readonly listBrokerIds: () => readonly string[]
  readonly logger?: IScopedLogger
}

/** The canned notification `testTarget` sends when the caller omits a sample. */
function cannedNotification(): Notification {
  return {
    body: 'This is a CamStack test notification.',
    title: 'CamStack',
    format: 'text',
    priority: 3,
  }
}

function readBrokerId(config: Readonly<Record<string, unknown>>): string | undefined {
  const value = config['brokerId']
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readService(config: Readonly<Record<string, unknown>>): string | undefined {
  const value = config['service']
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Build the `homeassistant` notification-output provider. Registered as a
 * collection entry alongside the HA addon's broker + device-adoption providers.
 */
export function createHaNotificationOutputProvider(
  deps: HaNotificationOutputDeps,
): INotificationOutputProvider {
  const { addonId, store, logger } = deps
  const descriptor = homeassistantTargetKind(addonId)

  /** Prefer an explicit target broker; else the only/first live broker. */
  function resolveBrokerId(config: Readonly<Record<string, unknown>>): string | null {
    const explicit = readBrokerId(config)
    if (explicit) return explicit
    return deps.listBrokerIds()[0] ?? null
  }

  /** Degrade → build → publish. NEVER throws through the cap. */
  async function dispatch(target: Target, raw: Notification): Promise<SendResult> {
    const notification =
      deps.readPublicEndpoint === undefined
        ? raw
        : await resolveAttachmentUrls({
            notification: raw,
            readPublicEndpoint: deps.readPublicEndpoint,
            ...(logger !== undefined ? { logger } : {}),
          })
    const prepared = prepareNotification(descriptor.caps, notification)
    const service = readService(target.config)
    if (!service) {
      return {
        success: false,
        error: 'Target is missing a notify service',
        renderedAs: prepared.renderedAs,
      }
    }
    const brokerId = resolveBrokerId(target.config)
    if (!brokerId) {
      return {
        success: false,
        error: 'No Home Assistant broker available',
        renderedAs: prepared.renderedAs,
      }
    }
    const serviceData = buildNotifyServiceData(prepared)
    try {
      await deps.publish(brokerId, service, serviceData)
      return { success: true, renderedAs: prepared.renderedAs }
    } catch (err) {
      logger?.warn('ha notify publish failed', {
        meta: { brokerId, service, error: errMsg(err) },
      })
      return { success: false, error: errMsg(err), renderedAs: prepared.renderedAs }
    }
  }

  return {
    listTargetKinds: async (): Promise<TargetKind[]> => {
      // `iconUrl` / `iconMediaType` are DECLARED on the cap's TargetKindSchema; the
      // runtime cap-router forwards provider output verbatim, so it reaches the
      // client unstripped. Assign to a variable first so the fresh-literal
      // excess-property check doesn't fire against `TargetKind`.
      const stamped =
        deps.iconUrl === undefined
          ? descriptor
          : deps.iconMediaType !== undefined
            ? { ...descriptor, iconUrl: deps.iconUrl, iconMediaType: deps.iconMediaType }
            : { ...descriptor, iconUrl: deps.iconUrl }
      return [stamped]
    },

    listTargets: async (): Promise<Target[]> => {
      const targets = await store.list()
      // No secrets in HA targets (the broker connection is reused) — just
      // stamp the routing addonId.
      return targets.map((target) => ({ ...target, addonId }))
    },

    getTarget: async ({ targetId }): Promise<Target> => {
      const target = await store.getById(targetId)
      if (!target) throw new Error(`Unknown target '${targetId}'`)
      // No secrets to un-redact (the broker connection is reused) — the same
      // shape `listTargets` returns, for the admin edit / duplicate flow.
      return { ...target, addonId }
    },

    discoverTargets: async ({ kind, config }): Promise<DiscoveredTarget[]> => {
      if (kind !== HA_NOTIFICATION_KIND) return []
      // The registry only improves labels: a failed read must not hide the services.
      const deviceNamesOf = async (brokerId: string): Promise<Map<string, string>> => {
        if (deps.listDevices === undefined) return new Map()
        try {
          return mobileAppDeviceNames(await deps.listDevices(brokerId))
        } catch (err) {
          logger?.warn('ha device registry read failed; naming services from their ids', {
            meta: { brokerId, error: errMsg(err) },
          })
          return new Map()
        }
      }
      const explicit = config ? readBrokerId(config) : undefined
      const brokerIds = explicit ? [explicit] : [...deps.listBrokerIds()]
      const out: DiscoveredTarget[] = []
      for (const brokerId of brokerIds) {
        try {
          const result = await deps.getServices(brokerId)
          out.push(...parseNotifyServices(result, brokerId, await deviceNamesOf(brokerId)))
        } catch (err) {
          logger?.warn('ha get_services discovery failed', {
            meta: { brokerId, error: errMsg(err) },
          })
        }
      }
      return out
    },

    probeTargetConfig: async ({ kind }) => ({
      ok: false,
      resolvedUrl: '',
      error: `Kind '${kind}' does not support credential probing`,
    }),

    send: async ({ targetId, notification }): Promise<SendResult> => {
      const target = await store.getById(targetId)
      if (!target) return { success: false, error: `Unknown target '${targetId}'` }
      if (!target.enabled) return { success: false, error: 'Target is disabled' }
      return dispatch(target, notification)
    },

    testTarget: async ({ targetId, sample }): Promise<SendResult> => {
      const target = await store.getById(targetId)
      if (!target) return { success: false, error: `Unknown target '${targetId}'` }
      return dispatch(target, sample ?? cannedNotification())
    },

    upsertTarget: async ({ target }): Promise<Target> => {
      const toStore: Target = { ...target, kind: HA_NOTIFICATION_KIND, addonId }
      await store.upsert(toStore)
      return toStore
    },

    deleteTarget: async ({ targetId }): Promise<void> => {
      await store.delete(targetId)
    },

    setTargetEnabled: async ({ targetId, enabled }): Promise<void> => {
      await store.setEnabled(targetId, enabled)
    },
  }
}
