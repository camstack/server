import { z } from 'zod'
import type { ConfigUISchema } from '../interfaces/config-ui.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'

/**
 * notification-output — canonical, capability-gated notification delivery.
 *
 * Apprise-derived model (see
 * `docs/superpowers/specs/2026-07-03-notification-output-notifier-matrix.md`):
 * callers emit ONE canonical `Notification`; each provider declares a
 * per-kind capability descriptor (`TargetKind`), and the pure degrade
 * engine (`@camstack/types` `prepareNotification`) transcodes / degrades the
 * message to what the kind supports — callers never special-case a service.
 *
 * DESIGN DECISIONS (locked):
 *  - Target CRUD lives on THIS cap (`upsertTarget` / `deleteTarget` /
 *    `setTargetEnabled`), each provider persisting via the `settings-store`
 *    cap. Rationale: the admin UI needs one uniform surface across the
 *    notifiers addon AND the HA addon; the addon-`globalSettingsSchema`-array
 *    alternative would fork the UI per addon and cannot host the
 *    discovery→adopt flow.
 *  - `listTargetKinds` / `listTargets` / `discoverTargets` return arrays →
 *    the generated cap-mount auto-`concatCollection`-fans them across every
 *    registered provider (notifiers addon + HA addon) so one catalog is
 *    routable. `send` / `testTarget` / CRUD route to ONE provider by the
 *    `addonId` the generated collection router extracts from the call input.
 *  - `Attachment.bytes` is `Uint8Array`. Transport-safe: superjson (the tRPC
 *    transformer) + UDS MsgPack both round-trip typed arrays — already used by
 *    `storage` / `storage-provider` / `recording` caps over the same path. No
 *    base64 fallback needed.
 *
 * TODO (deferred, closed-set change — separate decision): add
 * `providerKind: 'notify'` so notification providers surface on the unified
 * admin "Integrations" page.
 */

// ── Canonical message (§2 of the matrix) ────────────────────────────

/**
 * Zentik-derived typed-media enum — the superset across every kind. Each
 * adapter picks what it supports and the degrade engine filters the rest.
 */
export const AttachmentMediaTypeSchema = z.enum(['image', 'video', 'gif', 'audio', 'icon'])
export type AttachmentMediaType = z.infer<typeof AttachmentMediaTypeSchema>

/**
 * A single attachment. Exactly one of `url` (remote source, most adapters
 * prefer this) or `bytes` (inline source; required for Pushover-style
 * bytes-only kinds) MUST be present — the degrade engine expresses a
 * url→bytes fetch as a `needsFetch` directive the adapter executes.
 */
export const AttachmentSchema = z
  .object({
    mediaType: AttachmentMediaTypeSchema,
    url: z.string().optional(),
    bytes: z.instanceof(Uint8Array).optional(),
    mime: z.string().optional(),
    name: z.string().optional(),
  })
  .refine((a) => a.url !== undefined || a.bytes !== undefined, {
    message: 'Attachment requires either `url` or `bytes`',
  })
export type Attachment = z.infer<typeof AttachmentSchema>

export const NotificationFormatSchema = z.enum(['text', 'markdown', 'html'])
export type NotificationFormat = z.infer<typeof NotificationFormatSchema>

/**
 * The CLOSED icon vocabulary an action button may use.
 *
 * A closed set, not a free string, and that is the whole point: an arbitrary
 * icon name is one that ntfy renders, zentik silently drops, and nobody
 * notices — the same class of gap as a zone vocabulary nothing produced
 * ([D35](../../../docs/decisions/adr-0035.md)). Every adapter maps this set or
 * declares `actionIcons: false` and the degrade engine strips the field.
 *
 * Named by INTENT, never by glyph. "check" would tie the vocabulary to one
 * renderer's icon set; "acknowledge" survives an adapter that draws it
 * differently.
 *
 * ── A TOKEN IS NOT A WIRE VALUE ─────────────────────────────────────
 *
 * These names are for US. **No adapter may forward one verbatim.** Each maps
 * the whole set onto its own renderer's vocabulary through a
 * `Record<NotificationActionIcon, string>` — a Record, never a lookup with a
 * fallback, so adding a member here fails every adapter's build until someone
 * decides its glyph, which is the only place that decision can be made
 * honestly.
 *
 * This paragraph is the bug. Zentik declared `actionIcons: true` and passed
 * `disarm` straight through; iOS feeds that string to
 * `UNNotificationActionIcon(systemImageName:)`, `disarm` is not an SF Symbol,
 * and every snooze and alarm button arrived BLANK. A pass-through is not a
 * mapping, and "the field is documented" is not "the value renders".
 *
 * Adding a member is TRAIN-BOUND. The enum lives in the published
 * `@camstack/server` closure and the cap seam validates against the HUB's copy,
 * so an addon that emits a token the running hub does not know does not lose an
 * icon — its whole `send` fails Zod validation and the notification never
 * arrives. Never emit a new token from an addon before the train carrying it.
 */
export const NotificationActionIconSchema = z.enum([
  'acknowledge',
  'dismiss',
  /** A permanent/indefinite mute. For a TIMED window use `snooze`. */
  'silence',
  /** A timed "not now" — the snooze buttons a notification carries. */
  'snooze',
  'view',
  'play',
  'open',
  'close',
  'lock',
  'unlock',
  /** Armed, mode unspecified. Prefer a specific mode where one is known. */
  'arm',
  'arm-home',
  'arm-away',
  'arm-night',
  'disarm',
  'light',
  'alert',
  /** A camera, or an action scoped to one. */
  'camera',
])
export type NotificationActionIcon = z.infer<typeof NotificationActionIconSchema>

/** A single tap-through action button. */
export const NotificationActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  url: z.string().optional(),
  /** Dropped by the degrade engine for a kind with `caps.actionIcons: false`. */
  icon: NotificationActionIconSchema.optional(),
  /**
   * Renders in a warning style where the notifier supports it.
   *
   * A HINT, never a gate. The callback's authority is its token and nothing
   * else — see `notification-center/action-token.ts` for what that does and
   * does not buy.
   */
  destructive: z.boolean().optional(),
  /**
   * How the tap should REACH the url.
   *
   * `navigate` (absent, and every button authored before this field) opens it:
   * the phone leaves the notification and shows whatever the callback returns.
   * That is right for a button whose answer the operator wants to read.
   *
   * `background` fires it as a POST and stays put. It exists for the buttons
   * whose whole point is not to interrupt — "silence this for 30 minutes" is
   * an answer to the notification, and being thrown into a browser tab to
   * confirm it costs more attention than the notification did. A backend that
   * cannot do a background call renders it as an ordinary link (the adapters
   * fall back rather than dropping the button), so this is a preference, never
   * a requirement.
   */
  mode: z.enum(['navigate', 'background']).optional(),
})
export type NotificationAction = z.infer<typeof NotificationActionSchema>

/**
 * The canonical notification. `body` is the only hard field (Apprise model).
 * `priority` is a 5-level ORDINAL (1=lowest … 3=normal(default) … 5=urgent),
 * NOT a fixed severity enum — each kind declares its own `caps.levels` and
 * the adapter maps this ordinal onto its native level. `level?` is an
 * optional kind-native level id (`emergency`, `silent`, …) that overrides
 * `priority` for that one target.
 */
export const NotificationSchema = z.object({
  body: z.string(),
  title: z.string().optional(),
  format: NotificationFormatSchema.default('text'),
  priority: z.number().int().min(1).max(5).default(3),
  level: z.string().optional(),
  attachments: z.array(AttachmentSchema).optional(),
  clickUrl: z.string().optional(),
  actions: z.array(NotificationActionSchema).optional(),
  sound: z.string().optional(),
  ttl: z.number().optional(),
  tag: z.string().optional(),
  deviceId: z.number().optional(),
  eventId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

// ── Per-kind capability descriptor (§3 of the matrix) ───────────────

/** One declared native severity/priority level for a kind. */
export const TargetKindLevelSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** Which canonical priority (1..5) this level maps to. `null` = qualitative-only. */
  ordinal: z.number().int().min(1).max(5).nullable(),
  flags: z
    .object({
      critical: z.boolean().optional(),
      silent: z.boolean().optional(),
      noPush: z.boolean().optional(),
    })
    .optional(),
  /** e.g. Pushover `emergency` requires `retry` / `expire`. */
  requires: z.array(z.string()).optional(),
  description: z.string().optional(),
})
export type TargetKindLevel = z.infer<typeof TargetKindLevelSchema>

/** Attachment capabilities for a kind (drives the degrade engine + test panel). */
export const TargetKindAttachmentsCapsSchema = z.object({
  mediaTypes: z.array(AttachmentMediaTypeSchema),
  mode: z.enum(['url', 'bytes', 'both']),
  max: z.number().int().nonnegative(),
  maxBytes: z.number().int().positive().optional(),
})

/** The full capability block consulted before dispatch. */
export const TargetKindCapsSchema = z.object({
  attachments: TargetKindAttachmentsCapsSchema,
  /** Max action buttons (0 = none). */
  actions: z.number().int().nonnegative(),
  /**
   * Whether this kind renders a per-action ICON.
   *
   * `.optional()`, deliberately NOT `.default(false)`: a Zod default does not
   * run on the addon cap path — three production failures in one day taught
   * this repo that once. Absent is read as false by the degrade engine, which
   * is the safe direction: an icon that is not rendered costs nothing, an icon
   * assumed and dropped costs the operator's trust in the field.
   */
  actionIcons: z.boolean().optional(),
  levels: z.array(TargetKindLevelSchema),
  format: z.array(NotificationFormatSchema),
  clickUrl: z.boolean(),
  sound: z.boolean(),
  ttl: z.boolean(),
  bodyMaxLen: z.number().int().positive(),
})
export type TargetKindCaps = z.infer<typeof TargetKindCapsSchema>

/**
 * `configSchema` is a `ConfigUISchema` tree passed through to the admin
 * FormBuilder. Stored as `z.unknown()` at the cap seam (mirrors
 * `device-provider.getChildCreationSchema` `CreationSchemaOutputSchema`) —
 * the union is large and not meant for runtime validation here; the exported
 * `TargetKind` type re-tightens `configSchema` to `ConfigUISchema`.
 */
const ConfigSchemaPassthrough = z.unknown()

export const TargetKindSchema = z.object({
  kind: z.string(),
  label: z.string(),
  icon: z.string(),
  /** Stamped by each provider so the concat-fanned catalog stays routable. */
  addonId: z.string(),
  /**
   * URL of the kind's bundled BRAND icon, served by the providing addon over
   * its own `addon-routes` surface (`/addon/<addonId>/icons/<kind>`). Absent
   * when the addon bundles no icon for that kind — the client then falls back
   * to a neutral glyph rather than rendering the raw `icon` NAME as text.
   *
   * Root-relative on purpose: it resolves against whatever origin serves a web
   * client, and a native client joins it onto its own hub base.
   *
   * DECLARED here deliberately. It used to travel as an undeclared passthrough
   * field that survived only because the runtime cap-router forwards provider
   * output verbatim — so every consumer had to re-declare it by hand to stop
   * its own Zod parse from stripping it, and the whole arrangement would have
   * broken silently the moment output validation was tightened anywhere.
   */
  iconUrl: z.string().optional(),
  /**
   * Media type of {@link iconUrl} (`image/svg+xml`, `image/png`, …).
   *
   * The server knows this and therefore says it, because the client cannot
   * safely guess: a React-Native client renders SVG and raster through two
   * DIFFERENT components (`react-native-svg` vs `expo-image` — expo-image does
   * not decode SVG on iOS/Android), so without this it silently fell back to a
   * placeholder glyph for every vector icon while the web build looked fine.
   *
   * Absent when {@link iconUrl} is absent, or for a legacy provider that has
   * not been updated — a client that cannot determine the type should prefer
   * its raster path, which is the safe default for an unknown image.
   */
  iconMediaType: z.string().optional(),
  configSchema: ConfigSchemaPassthrough,
  /**
   * The config keys that decide WHERE this kind's secrets are sent (server,
   * base URL, instance, chat, recipient). A save that changes any of them
   * while leaving a secret redacted is refused by the provider (D634), so an
   * editor uses this to ask for the secret on exactly those edits instead of
   * on every edit.
   *
   * Optional: absent from a provider that holds no secret (the Home Assistant
   * kinds) and from a provider older than this field — an editor that finds
   * it absent must assume ANY edit may need the secret.
   */
  destinationKeys: z.array(z.string()).optional(),
  supportsDiscovery: z.boolean(),
  caps: TargetKindCapsSchema,
})
/** A kind descriptor with `configSchema` tightened to `ConfigUISchema`. */
export type TargetKind = Omit<z.infer<typeof TargetKindSchema>, 'configSchema'> & {
  readonly configSchema: ConfigUISchema
}

/**
 * A persisted target. `config` holds secrets; providers REDACT secret fields
 * (return a presence marker only) when serving `listTargets` — never
 * round-trip a stored secret to the UI.
 */
export const TargetSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  addonId: z.string(),
  enabled: z.boolean(),
  config: z.record(z.string(), z.unknown()),
})
export type Target = z.infer<typeof TargetSchema>

/** A discovery-surfaced candidate (config is partial + non-secret). */
export const DiscoveredTargetSchema = z.object({
  kind: z.string(),
  suggestedName: z.string(),
  config: z.record(z.string(), z.unknown()),
})
export type DiscoveredTarget = z.infer<typeof DiscoveredTargetSchema>

/** The degrade engine's report — what was resolved / dropped / degraded. */
export const RenderedAsSchema = z.object({
  level: z.string(),
  format: NotificationFormatSchema,
  attachmentsSent: z.number().int().nonnegative(),
  actionsSent: z.number().int().nonnegative(),
  truncated: z.boolean(),
  dropped: z.array(z.string()),
})
export type RenderedAs = z.infer<typeof RenderedAsSchema>

export const SendResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  renderedAs: RenderedAsSchema.optional(),
})
export type SendResult = z.infer<typeof SendResultSchema>

/** Same shape as SendResult — kept as a distinct name for the test panel. */
export const TestResultSchema = SendResultSchema
export type TestResult = SendResult

/**
 * Pre-save credential probe against a partial (unsaved) target config.
 * `resolvedUrl` never includes secrets (token stripped from path).
 */
export const ProbeTargetConfigResultSchema = z.object({
  ok: z.boolean(),
  resolvedUrl: z.string(),
  httpStatus: z.number().int().optional(),
  stateInstance: z.string().optional(),
  error: z.string().optional(),
})
export type ProbeTargetConfigResult = z.infer<typeof ProbeTargetConfigResultSchema>

// ── Capability definition ───────────────────────────────────────────

export const notificationOutputCapability = {
  name: 'notification-output',
  scope: 'system',
  mode: 'collection',
  methods: {
    // ── Tiers (D634) ────────────────────────────────────────────────
    // Everything that reads, redirects, fires or mutates a TARGET is
    // `auth: 'admin'`. Every non-admin role carries `category:system`, so a
    // `protected` method here was reachable by a viewer (every user's
    // targets, hosts and owners) and an operator (point any target, another
    // user's included, at a host of their choosing and `testTarget` the stored
    // secret there). Non-admins manage THEIR OWN targets through the
    // owner-checked `nc.*` bridge on the notifiers addon. Addons are not
    // affected: an addon's `ctx.api` cap call is resolved to the provider
    // directly and never enters the tRPC router — the tier gates sessions
    // and tokens, never addons.
    // Only the kind catalog stays open: descriptors carry no secret.
    //
    // Catalog + discovery (array output → auto concat fan-out across addons).
    listTargetKinds: method(z.object({}), z.array(TargetKindSchema)),
    listTargets: method(z.object({}), z.array(TargetSchema), { auth: 'admin' }),
    /**
     * One target WITH secrets — admin edit / duplicate hydration only.
     * `listTargets` stays redacted; the editor loads this so password fields
     * are filled (masked in the input) and a save can round-trip the token
     * when a destination changes (Duplicate with a new chatId, etc.).
     */
    getTarget: method(z.object({ targetId: z.string() }), TargetSchema, { auth: 'admin' }),
    // `config` is a partial, unsaved connection the operator has typed but not
    // yet persisted — so credential-gated discovery (gotify/zentik/telegram/…)
    // can authenticate against the endpoint the user is about to add. Admin:
    // it makes the hub dial a caller-chosen host.
    discoverTargets: method(
      z.object({
        kind: z.string(),
        config: z.record(z.string(), z.unknown()).optional(),
        /**
         * When editing / duplicating, the blank password field never round-trips
         * the stored token. Pass the source target id so the provider can restore
         * secrets server-side before dialling (same merge as upsert).
         */
        targetId: z.string().optional(),
      }),
      z.array(DiscoveredTargetSchema),
      { auth: 'admin' },
    ),
    // Pre-save credential check against an unsaved config (e.g. Green API
    // getStateInstance). Routed to ONE provider by addonId — same as upsert.
    probeTargetConfig: method(
      z.object({
        kind: z.string(),
        config: z.record(z.string(), z.unknown()),
        /** See `discoverTargets.targetId` — restore stored secrets for a blank password. */
        targetId: z.string().optional(),
      }),
      ProbeTargetConfigResultSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
    // Dispatch — routed to ONE provider by addonId in the call input.
    send: method(
      z.object({ targetId: z.string(), notification: NotificationSchema }),
      SendResultSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
    testTarget: method(
      z.object({ targetId: z.string(), sample: NotificationSchema.optional() }),
      TestResultSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
    // Target CRUD (cap methods — see header decision).
    upsertTarget: method(
      z.object({
        target: TargetSchema,
        /**
         * Duplicate flow: create a NEW target id while copying secrets from an
         * existing row. The UI never holds the stored token; blank / redacted
         * password fields are restored from this source (D634 still applies if
         * destinations diverge without a re-typed secret).
         */
        cloneSecretsFrom: z.string().optional(),
      }),
      TargetSchema,
      {
        kind: 'mutation',
        auth: 'admin',
      },
    ),
    deleteTarget: method(z.object({ targetId: z.string() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    setTargetEnabled: method(z.object({ targetId: z.string(), enabled: z.boolean() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
  },
} as const satisfies CapabilityDefinition

export type INotificationOutputProvider = InferProvider<typeof notificationOutputCapability>
