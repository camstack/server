import { z } from 'zod'
import {
  method,
  type CapabilityDefinition,
  type InferProvider,
  type UiContributionRemote,
} from './capability-definition.js'

/**
 * `addon-widgets-source` — collection cap exposing per-addon raw widget
 * declarations. Mirrors the addon-pages split: every addon shipping
 * widgets registers a provider on this collection cap; the hub-local
 * aggregator (`addon-widgets`, see `addon-widgets.cap.ts`) walks the
 * collection, stamps versioned `bundleUrl`s onto each declaration, and
 * exposes the public listing surface that admin-ui consumes.
 *
 * The split exists because the public listing has a different output
 * shape (flat enriched metadata with `addonId` + `bundleUrl`) than the
 * per-provider raw declarations. Both ends flow through codegen.
 *
 * Unified UI-contribution model (Task 10): a widget descriptor IS a
 * `UiContribution` with `kind:'remote'`. The host renders it through the
 * same `ContributionRenderer` / Module-Federation path as every other
 * contributed UI surface — no bespoke widget-rendering path. The widget-
 * only metadata (sizing hints, `requires`) lives as extra fields on the
 * descriptor; the `UiContribution` core (`tab` / `label` / `order` /
 * `kind` / `remote`) carries identity + placement + the MF remote.
 */

/** Where the widget makes sense to render — maps to a contribution `tab`. */
const WidgetHostEnum = z.enum(['device-tab', 'dashboard', 'integration-detail'])
const WidgetSizeEnum = z.enum(['xs', 'sm', 'md', 'lg', 'xl'])

/**
 * MF remote descriptor — mirrors `UiContributionRemote` from
 * `capability-definition.ts`. Widget remotes expose a single
 * `'./widgets'` module whose default export is a
 * `Record<componentKey, Component>` map; `componentKey` (the widget
 * `stableId`) picks the entry the host mounts.
 */
const WidgetRemoteSchema = z.object({
  remoteName: z.string(),
  exposedModule: z.string(),
  componentKey: z.string().optional(),
})

/**
 * Compile-time structural assertion that `WidgetRemoteSchema` stays in
 * lockstep with the `UiContributionRemote` TS interface. A field
 * divergence (rename, added required field, dropped field) breaks the
 * build instead of drifting silently. `satisfies z.ZodType<...>` is too
 * strict here because Zod's `.optional()` models `componentKey` as
 * `string | undefined` rather than an exact-optional property, so the
 * lenient assignment form is used instead.
 */
const _widgetRemoteSchemaCheck: z.ZodType<UiContributionRemote> = WidgetRemoteSchema
void _widgetRemoteSchemaCheck

/**
 * One widget declaration — a `UiContribution` (`kind:'remote'`) plus
 * widget-only metadata. The `UiContribution` core fields:
 *
 *  - `tab`     — where the widget hosts. A widget that runs on the
 *                dashboard declares `tab:'dashboard'`; a device-tab
 *                widget declares the target device-detail tab id.
 *  - `subTab`  — optional sub-tab within `tab`.
 *  - `label`   — operator-facing label.
 *  - `order`   — ordering within `(tab, subTab)`.
 *  - `kind`    — always `'remote'` for widgets.
 *  - `remote`  — the MF remote `{ remoteName, exposedModule, componentKey }`.
 *
 * Widget-only fields retained alongside the contribution core:
 *
 *  - `stableId`      — stable identity within the addon (the MF
 *                      `componentKey`; kept top-level so consumers have
 *                      a stable key without reaching into `remote`).
 *  - `description` / `icon` — picker metadata.
 *  - `bundle`        — entry filename inside the addon `dist/` dir; the
 *                      aggregator stamps a versioned `bundleUrl` from it.
 *  - `hosts`         — every host the widget supports (a widget can run
 *                      both on the dashboard and a device tab). `tab`
 *                      is the PRIMARY host; `hosts` is the full set the
 *                      picker filters on.
 *  - `requires`      — host-context requirements validated at mount.
 *  - `defaultSize` / `allowedSizes` / `defaultColumns` / `defaultRows`
 *                    — dashboard placement hints.
 */
const WidgetMetadataSchema = z.object({
  // ── UiContribution core (kind:'remote') ──────────────────────────
  /** Primary host tab — `'dashboard'`, `'device-tab'`, or a device-detail tab id. */
  tab: z.string(),
  /** Optional sub-tab within `tab`. */
  subTab: z.string().optional(),
  /** Operator-facing label. */
  label: z.string(),
  /** Ordering within `(tab, subTab)`, ascending. */
  order: z.number().optional(),
  /** Always `'remote'` — a widget is a Module Federation remote. */
  kind: z.literal('remote'),
  /** MF remote descriptor. */
  remote: WidgetRemoteSchema,

  // ── Widget-only metadata ─────────────────────────────────────────
  /** Stable id within the addon — kebab-case. Equals `remote.componentKey`. */
  stableId: z.string(),
  description: z.string().optional(),
  icon: z.string().optional(),
  /**
   * Bundle filename inside the addon's `dist/` dir served at
   * `/api/addon-widgets/<addonId>/<bundle>`. With Module Federation
   * this is always `'remoteEntry.js'` — the value is kept on the
   * metadata so the static-file route can compute an mtime-based
   * cache-buster URL without a separate filesystem stat.
   */
  bundle: z.string(),
  /** Every host the widget supports. The picker filters on this set. */
  hosts: z.array(WidgetHostEnum).readonly(),
  /** Required props the host must supply. Validated at `<WidgetSlot>` mount. */
  requires: z.object({
    deviceContext: z.boolean().default(false),
    integrationContext: z.boolean().default(false),
  }),
  /**
   * Loadable BEFORE authentication. The normal widget registry listing
   * (`addon-widgets.listWidgets`) is auth-gated, so a pre-auth surface
   * (the login page) cannot discover a widget through it. A widget that
   * declares `preAuth: true` marks itself as safe to mount on a pre-auth
   * screen — it is surfaced through the PUBLIC `auth.listLoginMethods`
   * login-method contribution channel (see `login-method.cap.ts`) rather
   * than the authenticated registry, and its bundle is served by the
   * public `/api/addon-widgets/:addonId/*` static route. Defaults false.
   */
  preAuth: z.boolean().optional().default(false),
  /** Dashboard placement HINTS (operator can override per instance). */
  defaultSize: WidgetSizeEnum.default('md'),
  allowedSizes: z.array(WidgetSizeEnum).readonly().default(['sm', 'md', 'lg']),
  defaultColumns: z.number().int().min(1).max(12).default(6),
  defaultRows: z.number().int().min(1).max(12).default(1),
})

export const addonWidgetsSourceCapability = {
  name: 'addon-widgets-source',
  scope: 'system',
  mode: 'collection',
  internal: true,
  methods: {
    /**
     * `internal: true` did not gate the mount (see the 2026-08-26 note on
     * `data-store-provider`) — this was reachable on the AppRouter by ANY
     * authenticated session at the default `auth: 'protected'`. The only
     * consumer, the `addon-widgets-aggregator` builtin, reads it via
     * `ctx.capabilities.getCollection('addon-widgets-source')` — LOCAL-PROCESS
     * only, never tRPC. The public, enriched listing admin-ui actually
     * consumes is the separate `addon-widgets` cap (`listWidgets` there is
     * gated separately, and a `preAuth: true` widget is surfaced through the
     * PUBLIC `auth.listLoginMethods` contribution channel instead) —
     * neither is affected by this change.
     */
    listWidgets: method(z.void(), z.array(WidgetMetadataSchema).readonly(), { auth: 'admin' }),
  },
} as const satisfies CapabilityDefinition

export type IAddonWidgetsSourceProvider = InferProvider<typeof addonWidgetsSourceCapability>

/** A single widget declaration — a `UiContribution` (`kind:'remote'`) + widget metadata. */
export type WidgetMetadata = z.infer<typeof WidgetMetadataSchema>

export { WidgetMetadataSchema, WidgetRemoteSchema, WidgetHostEnum, WidgetSizeEnum }
