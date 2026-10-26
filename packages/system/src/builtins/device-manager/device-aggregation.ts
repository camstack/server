/**
 * Device-details aggregation + field-update routing for the device-manager
 * addon. Extracted from `device-manager.addon.ts` as free functions that
 * receive an explicit `AggregationDeps` context (DI) rather than closing over
 * the addon instance.
 *
 * This module owns the binding-driven settings/live/status aggregators
 * (`getDeviceAggregate`, `collectSystemDeviceContributions`,
 * `deriveDeviceConfigContribution`, `buildBaseDeviceSection`,
 * `getDeviceStatusAggregate`, `resolveDriverConfigSchema`) and the
 * field-update routing (`updateDeviceField`, `updateDeviceFieldsBatch`,
 * `applyGroupPatch`, `resolveContributionProvider`, `dispatchDeviceAction`)
 * plus the wrapper-activation mutators (`setWrapperActive`,
 * `listWrappersForCap`, `listBindableCapsForDeviceType`).
 *
 * Sibling aggregator functions call each other directly (passing `deps`);
 * cross-domain leaf calls (`getBindings`, `resolveRemoteNativeCapFromRegistry`,
 * read/writeBindingsStore) route through the bindings-store module via
 * `deps.bindingsDeps`. EXACT semantics, ordering, and side effects of the
 * original class methods are preserved; the addon keeps thin delegator
 * methods over these functions.
 */
import type {
  AddonContext,
  CapabilityDefinition,
  ConfigUISchemaWithValues,
  DeviceBindingEntry,
  DeviceConfigSpec,
  DeviceSettingsContribution,
  ICapabilityRegistry,
  IDevice,
  IDeviceOpsProvider,
  InferProvider,
  StreamProfile,
  StreamProfilePatch,
  WireableField,
} from '@camstack/types'
import {
  ALL_CAPABILITY_DEFINITIONS,
  CAP_NAMES_WITH_STATUS,
  deviceManagerCapability,
  enumerateItemArrayFields,
  enumerateSchemaFields,
  errMsg,
  isDeviceConfigCap,
  sleep,
} from '@camstack/types'
import { ContributionCache, CONTRIBUTION_BUDGET_MS } from './contribution-cache.js'
import { mergeAggregates, tagContribution, toWireShape } from './device-aggregation-merge.js'
import { applyDriverFormPatch, viewStoredSecrets } from './device-form-secrets.js'
import {
  type BindingsDeps,
  getBindings,
  type RemoteNativeCaps,
  resolveRemoteNativeCapFromRegistry,
} from './device-bindings-store.js'
import {
  applyDerivedFormProfilePatch,
  deriveFormContribution,
  parseDerivedFormSettingsPatch,
} from './device-config-contribution.js'
import type { ContributionShape, DriverConfigSchemaResult } from './device-meta-types.js'
import { LINKED_DEVICES_RESERVED_KEYS } from './device-linked-devices.js'
import { isTransientMoleculerError, resolveDeviceById } from './device-projection.js'

/**
 * Dependencies the aggregation + update routing functions consume. Assembled
 * by the addon from its own state and passed in explicitly — no hidden `this`
 * capture. `bindingsDeps` carries the lower-level context the bindings-store
 * resolvers need so this module can call them directly.
 */
export interface AggregationDeps {
  readonly ctx: AddonContext
  readonly capabilityRegistry: ICapabilityRegistry | undefined
  readonly remoteNativeCaps: RemoteNativeCaps
  readonly bindingsDeps: BindingsDeps
  /**
   * The keychain side of a driver's device form (D789): the STORED blob (its
   * markers, never resolved), the device's declared secret paths, and the
   * door's explicit clear. Without it a driver form carries what the driver
   * hydrated and a clear cannot be applied.
   */
  readonly deviceFormSecrets?: DeviceFormSecretsDeps
}

export interface DeviceFormSecretsDeps {
  readonly readStored: (deviceId: number) => Promise<Record<string, unknown>>
  readonly declaredPaths: (deviceId: number) => readonly string[]
  readonly clear: (deviceId: number, keys: readonly string[]) => Promise<void>
}

/**
 * A driver's hydrated sections as the browser may see them: every secret the
 * keychain stores is its VIEW, never the plaintext the driver was handed by
 * `loadConfig`. An unreadable blob withholds nothing new — the non-admin
 * redaction still runs at the transport — but it is logged.
 */
async function driverSectionsWithSecretViews(
  deps: AggregationDeps,
  deviceId: number,
  sections: ContributionShape['sections'],
): Promise<ContributionShape['sections']> {
  const door = deps.deviceFormSecrets
  if (!door) return sections
  try {
    return viewStoredSecrets(
      sections,
      await door.readStored(deviceId),
      door.declaredPaths(deviceId),
    )
  } catch (err: unknown) {
    deps.ctx.logger.warn('device form: stored config unreadable — secret views not applied', {
      tags: { deviceId },
      meta: { error: errMsg(err) },
    })
    return sections
  }
}

type IDeviceManagerProvider = InferProvider<typeof deviceManagerCapability>

/**
 * One process-wide cache behind every device-details fan-out.
 *
 * Module-level on purpose: the page re-polls every 2.5 s and a per-call cache
 * would be empty every time, which is the same as having none.
 */
const contributionCache = new ContributionCache<ContributionShape>()

interface ResolveContributionInput {
  readonly deviceId: number
  readonly kind: 'settings' | 'live'
  readonly capName: string
  readonly addonId: string
  readonly call: () => Promise<ContributionShape | null>
}

/**
 * Ask ONE provider for its contribution, bounded, and say what happened.
 *
 * The two non-fresh outcomes are logged because they are the two questions an
 * operator asks of a slow device page, and neither had an answer before: WHICH
 * provider is slow, and whether the panel in front of them is current.
 */
async function resolveContribution(
  deps: AggregationDeps,
  input: ResolveContributionInput,
): Promise<ContributionShape | null> {
  const { deviceId, kind, capName, addonId } = input
  const outcome = await contributionCache.resolve(
    `${String(deviceId)}:${kind}:${capName}:${addonId}`,
    input.call,
  )
  if (outcome.kind === 'fresh') {
    return outcome.value === null ? null : tagContribution(outcome.value, capName, addonId, kind)
  }
  if (outcome.kind === 'stale') {
    // Sampled by nothing on purpose: it fires once per slow provider per poll,
    // and a provider that is slow on every poll is exactly the finding.
    deps.ctx.logger.info('device contribution served from the last answer — the provider is slow', {
      tags: { deviceId, addonId },
      meta: { capName, method: kind, budgetMs: CONTRIBUTION_BUDGET_MS },
    })
    return tagContribution(outcome.value, capName, addonId, kind)
  }
  deps.ctx.logger.warn('device contribution unavailable — the panel is missing this section', {
    tags: { deviceId, addonId },
    meta: { capName, method: kind, reason: outcome.reason, budgetMs: CONTRIBUTION_BUDGET_MS },
  })
  return null
}

export async function getDeviceAggregate(
  deps: AggregationDeps,
  deviceId: number,
  kind: 'settings' | 'live',
): Promise<ContributionShape | null> {
  const registry = deps.capabilityRegistry
  if (!registry) {
    deps.ctx.logger.debug('capability registry unavailable — aggregate empty', { meta: { kind } })
    return null
  }
  const method = kind === 'settings' ? 'getDeviceSettingsContribution' : 'getDeviceLiveContribution'

  // D12: per-device aggregation is BINDING-DRIVEN. Walk only the
  // (cap, provider) pairs actually bound to this device — never the
  // global set of providers that share a cap name. A device belongs to
  // exactly one integration; its contributions come only from providers
  // bound to it.
  //
  // System-scoped caps with `exposesDeviceSettings` (stream-broker,
  // device-export) hold per-device state but are NOT device-bound — a system
  // addon is not a BaseDevice, never calls `registerNativeCap`, and so never
  // appears in `getBindings`. They are consulted separately below by
  // `collectSystemDeviceContributions`. `seenCaps` lets that pass skip any
  // system cap that DID arrive via a binding (e.g. a native registration in a
  // test) so its section is never duplicated.
  const { entries: bindingEntries } = await getBindings(deps.bindingsDeps, { deviceId })
  const seenCaps = new Set(bindingEntries.map((e) => e.capName))

  const results = await Promise.all(
    bindingEntries.map(async (entry) => {
      const def = registry.getDefinition(entry.capName)
      // D14: a `deviceConfig` cap's contribution is FRAMEWORK-DERIVED.
      if (isDeviceConfigCap(def)) {
        return deriveDeviceConfigContribution(deps, registry, def, entry, deviceId, kind)
      }
      if (!def?.exposesDeviceSettings) return null
      // Bug-3 fix: contribution methods (getDeviceSettingsContribution,
      // getDeviceLiveContribution, applyDeviceSettingsPatch) live on the
      // provider registered by `entry.providerAddonId` — the wrapper addon
      // for `kind:'wrapped'` entries (e.g. SnapshotAddon), or the system
      // addon for native-only singletons. `getProviderForDevice` would
      // return the per-device NATIVE first when present (e.g. Reolink/ONVIF),
      // which does NOT implement contribution methods and throws
      // "native-provider: method not found". `getProviderByAddon` resolves
      // exactly the provider the binding entry points to, bypassing the
      // native-first resolution order.
      const provider = registry.getProviderByAddon<DeviceSettingsContribution>(
        entry.capName,
        entry.providerAddonId,
      )
      if (!provider) return null
      return await resolveContribution(deps, {
        deviceId,
        kind,
        capName: entry.capName,
        addonId: entry.providerAddonId,
        call: async () => {
          const contribution = await provider[method]({ deviceId })
          return contribution ? toWireShape(contribution) : null
        },
      })
    }),
  )

  const base = kind === 'settings' ? await buildBaseDeviceSection(deps, deviceId) : null
  const systemResults = await collectSystemDeviceContributions(deps, deviceId, kind, seenCaps)
  const parts: ContributionShape[] = [
    ...(base ? [tagContribution(base, 'device-manager', 'device-manager', kind)] : []),
    ...results.filter((r): r is ContributionShape => r !== null),
    ...systemResults,
  ]
  if (parts.length === 0) return null
  return mergeAggregates(parts)
}

/**
 * System-scoped per-device contributions — the deliberate exception to
 * binding-driven aggregation (D12).
 *
 * A `scope: 'system'` cap with `exposesDeviceSettings: true` holds per-device
 * state but is NOT bound per-device: it is a system addon, not a BaseDevice,
 * so it never calls `registerNativeCap` and never appears in
 * `getBindings(deviceId)`. The binding-driven loop therefore skips it and its
 * per-device panel never renders. Two such caps ship today:
 *   - `stream-broker` (singleton) — the RTSP-restream / pre-buffer settings
 *     tab, scoped to the cameras whose streams it serves.
 *   - `device-export` (collection) — the "Export" panel; a device can be
 *     exposed to MULTIPLE exporters at once (Alexa + HomeKit + HA-MQTT).
 *
 * D12 bans fanning a per-device call out to every same-named provider of a
 * `scope: 'device'` cap, because vendor providers SHARE cap names
 * (`stream-params`/`ptz` from reolink AND hikvision). System caps are NOT
 * vendor-shared — a system cap name maps to one active provider (singleton)
 * or one declared collection — so consulting the cap's own provider(s)
 * directly is safe. Each provider gates internally by deviceId and returns
 * null for devices it does not own.
 *
 * `seenCaps` skips any system cap that already contributed via a binding so
 * its section is never duplicated.
 */
export async function collectSystemDeviceContributions(
  deps: AggregationDeps,
  deviceId: number,
  kind: 'settings' | 'live',
  seenCaps: ReadonlySet<string>,
): Promise<ContributionShape[]> {
  const registry = deps.capabilityRegistry
  if (!registry) return []
  const method = kind === 'settings' ? 'getDeviceSettingsContribution' : 'getDeviceLiveContribution'

  const tasks: Array<Promise<ContributionShape | null>> = []
  for (const info of registry.listCapabilities()) {
    const def = registry.getDefinition(info.name)
    if (!def || def.scope !== 'system' || !def.exposesDeviceSettings) continue
    if (seenCaps.has(info.name)) continue
    // Singleton → the active provider only. Collection → every registered
    // provider (each contributes its own opt-in per-device panel).
    const addonIds =
      def.mode === 'collection' ? info.providers : info.activeProvider ? [info.activeProvider] : []
    for (const addonId of addonIds) {
      tasks.push(
        (async (): Promise<ContributionShape | null> => {
          const provider = registry.getProviderByAddon<DeviceSettingsContribution>(
            info.name,
            addonId,
          )
          if (!provider) return null
          // Same budget, same cache, same two log lines as the binding-driven
          // half above: a system cap holds per-device panels too, and a slow
          // one stalls the identical page.
          return await resolveContribution(deps, {
            deviceId,
            kind,
            capName: info.name,
            addonId,
            call: async () => {
              const contribution = await provider[method]({ deviceId })
              return contribution ? toWireShape(contribution) : null
            },
          })
        })(),
      )
    }
  }
  return (await Promise.all(tasks)).filter((r): r is ContributionShape => r !== null)
}

/**
 * D14: framework-derived device-config contribution.
 *
 * `kind === 'live'` — device-config caps contribute nothing to the live
 * aggregate (they hold editable config, not live observables).
 *
 * `ui.kind === 'widget'` — emits a single structural `type:'widget'`
 * section; the widget self-persists via the cap's own mutations.
 *
 * `ui.kind === 'derived-form'` — calls `getOptions`/`getStatus` on the
 * bound provider, runs the registered pure builder, and returns the
 * derived form sections. Returns null when the camera exposes nothing
 * configurable or the provider is not yet registered.
 */
export async function deriveDeviceConfigContribution(
  deps: AggregationDeps,
  registry: ICapabilityRegistry,
  def: CapabilityDefinition & { deviceConfig: DeviceConfigSpec },
  entry: DeviceBindingEntry,
  deviceId: number,
  kind: 'settings' | 'live',
): Promise<ContributionShape | null> {
  // device-config caps contribute nothing to the LIVE aggregate.
  if (kind === 'live') return null
  const ui = def.deviceConfig.ui

  if (ui.kind === 'widget') {
    // Structural section: one `type:'widget'` field. The widget
    // self-persists via the cap's own mutations.
    const section: ContributionShape['sections'][number] = {
      id: `${entry.capName}-widget`,
      title: ui.label,
      tab: ui.tab,
      order: ui.order ?? 0,
      // `hero` wins over `topTab`: the section is shown once under the
      // device's hero card and never also lands in a tab (D915).
      ...(ui.placement === 'hero'
        ? { location: 'hero' as const }
        : ui.topTab
          ? { location: 'top-tab' as const }
          : {}),
      fields: [
        {
          type: 'widget',
          key: `${entry.capName}Widget`,
          label: ui.label,
          widgetId: ui.widgetId,
        },
      ],
    }
    return tagContribution({ sections: [section] }, entry.capName, entry.providerAddonId, kind)
  }

  // ui.kind === 'derived-form'
  const provider = registry.getProviderForDevice<{
    getOptions?: (input: { deviceId: number }) => Promise<unknown>
    getStatus?: (input: { deviceId: number }) => Promise<unknown>
  }>(entry.capName, deviceId)
  if (!provider || typeof provider.getOptions !== 'function') return null
  try {
    const options = await provider.getOptions({ deviceId })
    const status =
      typeof provider.getStatus === 'function' ? await provider.getStatus({ deviceId }) : null
    const derived = deriveFormContribution(ui.builderId, options, status ?? null)
    if (!derived) return null
    const wire: ContributionShape = {
      ...(derived.tabs ? { tabs: derived.tabs.map((t) => ({ ...t })) } : {}),
      sections: derived.sections.map((s) => ({
        id: s.id,
        title: s.title,
        ...(s.tab !== undefined ? { tab: s.tab } : {}),
        ...(s.order !== undefined ? { order: s.order } : {}),
        ...(s.description !== undefined ? { description: s.description } : {}),
        ...(s.columns !== undefined ? { columns: s.columns } : {}),
        fields: [...s.fields],
      })),
    }
    return tagContribution(wire, entry.capName, entry.providerAddonId, kind)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    deps.ctx.logger.warn('device-config derivation failed', {
      tags: { deviceId, addonId: entry.providerAddonId },
      meta: { capName: entry.capName, error: msg },
    })
    return null
  }
}

/**
 * Build the device-manager's own contribution to the aggregator — the
 * device identity (id, stableId, addonId, type, online) + the
 * driver-specific config exposed by the device class via
 * `zodEntriesToConfigUI`.
 *
 * Two paths, deliberately symmetric with `getSettingsSchema`:
 *
 *  - Hub-local: device's IDevice instance lives in this process'
 *    DeviceRegistry, we read config + schema directly by reference.
 *  - Cross-process: device lives in a forked worker (RtspCamera on
 *    provider-rtsp, ONVIF on provider-onvif, …). We ask the worker's
 *    `device-ops.getSettingsSchema` native provider for a wire-
 *    serializable ConfigUISchema and merge it in under the same
 *    "Driver Config" section, so the UI sees the same shape regardless
 *    of where the IDevice physically runs.
 *
 *  Returns `null` only when the device genuinely doesn't exist anywhere
 *  (no hub-local, no persisted ownership, no device-ops native). The
 *  aggregator falls back to contributor sections only in that case.
 */
export async function buildBaseDeviceSection(
  deps: AggregationDeps,
  deviceId: number,
): Promise<ContributionShape | null> {
  const hubRegistry = deps.ctx.kernel?.deviceRegistry
  const hubLocal = hubRegistry ? resolveDeviceById(hubRegistry, deviceId) : null

  // Existence gate: hub-local registry OR a `device-ops` native owner
  // (`resolveNativeDeviceOwner` checks hub-local caps, then the push-fed
  // `remoteNativeCaps` cache, then the handshake-fed `HubNodeRegistry`).
  // Identity facts (Device ID / Stable ID / Driver) used to render here as
  // a Config "Identity" section; they duplicated Overview's Device Info
  // card, so Config only carries editable driver preferences now.
  const nativeOwner = resolveNativeDeviceOwner(deps, deviceId)
  if (!hubLocal && !nativeOwner) return null

  const sections: ContributionShape['sections'] = []
  // Hardware-info metadata is exposed read-only via `getDevice` and
  // rendered by a dedicated UI tab — it's facts, not preferences,
  // so it doesn't belong in the editable settings aggregate.

  // Driver config — either built in-process from the live IDevice's Zod
  // schema (hub-local path) or obtained as a pre-built ConfigUISchema
  // from the worker that owns the device (cross-process path).
  //
  // `resolveDriverConfigSchema` now returns a discriminated result so we
  // can distinguish "no schema" (none) from "worker temporarily unreachable"
  // (unavailable). The latter renders a visible placeholder instead of
  // silently omitting the driver's settings sections.
  const driverResult = await resolveDriverConfigSchema(deps, deviceId, hubLocal)

  if (driverResult.status === 'ok') {
    const driverSections = await driverSectionsWithSecretViews(
      deps,
      deviceId,
      driverResult.schema.sections,
    )
    for (const section of driverSections) {
      sections.push({
        id: section.id,
        title: section.title,
        tab: section.tab ?? 'general',
        order: section.order ?? 1,
        fields: [...section.fields],
        ...(section.description !== undefined ? { description: section.description } : {}),
        ...(section.columns !== undefined ? { columns: section.columns } : {}),
      })
    }
  } else if (driverResult.status === 'unavailable') {
    // The forked addon worker is mid-restart or briefly disconnected.
    // Surface a read-only info section so the admin UI shows a clear
    // message instead of a silently missing configuration panel.
    sections.push({
      id: 'driver-settings-unavailable',
      title: 'Driver Settings',
      titleKey: 'server:baseDeviceSection.s_driver-settings-unavailable.title',
      tab: 'general',
      order: 1,
      fields: [
        {
          type: 'info',
          key: 'driver-settings-unavailable-notice',
          label: 'Temporarily unavailable',
          labelKey:
            'server:baseDeviceSection.s_driver-settings-unavailable.driver-settings-unavailable-notice.label',
          content:
            'Driver settings are temporarily unavailable — the addon may be restarting. Refresh the page in a moment.',
          variant: 'warning',
        },
      ],
    })
  }
  // status === 'none' → driver has no settings; nothing to add.

  // No identity section and no driver sections ⇒ this base contribution
  // would be empty. Return null so the aggregator does not keep a hollow
  // part that only existed to host the removed Identity card — and so the
  // Config tab can hide itself when nothing else contributes either.
  if (sections.length === 0) return null

  // Propagate driver-declared tab metadata (label + icon + order).
  // Without this the merge step in `mergeAggregates` falls back to
  // auto-derived tabs (raw id as label, generic icon) — UI then shows
  // lowercase `sessions` / `streams` instead of the driver's
  // `Sessions` / `Streams`. First-wins inside mergeAggregates so the
  // driver's declarations beat any later contributor.
  return {
    sections,
    ...(driverResult.status === 'ok' && driverResult.schema.tabs
      ? { tabs: [...driverResult.schema.tabs] }
      : {}),
  }
}

/**
 * Lookup the native owner for `device-ops` on `deviceId` — the native-cap
 * registry (hub-local and remote) is keyed by numeric id.
 */
export function resolveNativeDeviceOwner(
  deps: AggregationDeps,
  deviceId: number,
): { addonId: string; nodeId: string } | null {
  const local = deps.capabilityRegistry?.getNativeAddonId('device-ops', deviceId) ?? null
  if (local) return { addonId: local, nodeId: deps.ctx.kernel.localNodeId ?? 'hub' }
  // Check push-fed cache first, then fall through to handshake-fed registry.
  const remote =
    deps.remoteNativeCaps.get(deviceId)?.get('device-ops') ??
    resolveRemoteNativeCapFromRegistry(deps.bindingsDeps, 'device-ops', deviceId)
  return remote ? { addonId: remote.addonId, nodeId: remote.nodeId } : null
}

/**
 * How long ONE cap's `getStatus` may take before the aggregate gives up on it
 * and reports `null`.
 *
 * A cap call for a device owned by another node crosses the cluster, where the
 * transport's own ceiling is `REMOTE_CALL_TIMEOUT_MS` — SIXTY seconds. That
 * ceiling is right for a deliberate operator action; it is catastrophic here,
 * because this aggregate is what a camera LIST asks for on every boot, and it
 * has no answer to give until the slowest cap replies.
 *
 * The failure this bounds is not a node that is DOWN — `classifyCapRoute`
 * rejects those immediately with `node-offline`, which the catch below turns
 * into `null` in microseconds. It is a node that is FLAPPING: a crash-looping
 * agent re-registers every few seconds, so the registry believes it is online,
 * the call is routed, and the peer dies mid-flight. Then nothing throws and
 * nothing resolves. On 2026-08-08 agent-a did exactly that for 22
 * minutes and the viewer showed a loading skeleton the whole time.
 *
 * 3s is chosen against what a HEALTHY remote cap costs (a same-LAN cap call is
 * single-digit ms; the slowest observed live is ~300ms) — so this cannot cut
 * off a working node — and against what a human waits for a camera list.
 */
export const STATUS_CALL_DEADLINE_MS = 3_000

/** Per-call bound for a status aggregation. Tests pass a small value; nothing
 *  in production overrides the default. */
export interface StatusAggregateOptions {
  /** Deadline for a single cap's `getStatus`. Defaults to
   *  {@link STATUS_CALL_DEADLINE_MS}. */
  readonly deadlineMs?: number
}

/** A call that finished in time, or the deadline firing first. */
type DeadlineOutcome<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'timed-out' }

/**
 * Race `work` against a deadline WITHOUT swallowing its rejection.
 *
 * `Promise.race` attaches a handler to every entrant, so a `work` that rejects
 * after the deadline already fired is still handled — no unhandled rejection,
 * and no `.catch(() => {})` that would also hide a genuine throw from the
 * caller's `try`. A rejection propagates out of here exactly as it would
 * without the race; only the TIMEOUT is turned into a value.
 */
async function withDeadline<T>(work: Promise<T>, deadlineMs: number): Promise<DeadlineOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<DeadlineOutcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timed-out' }), deadlineMs)
    // A pending deadline must never be the reason a process stays alive.
    timer.unref?.()
  })
  try {
    return await Promise.race([
      work.then((value): DeadlineOutcome<T> => ({ kind: 'value', value })),
      deadline,
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Aggregate `status` across every registered cap for a device.
 *
 * Walks the supplied cap list (or `CAP_NAMES_WITH_STATUS` when
 * omitted), looks up a native provider per cap via the capability
 * registry, calls `provider.getStatus({ deviceId })`, and validates
 * the return against the cap's own `status.schema`. Validation
 * failures log a warning and yield `null` for that cap so the
 * overall aggregate stays usable — a single misbehaving provider
 * must not blank out a device's entire status view.
 *
 * A provider that never answers is treated exactly like one that throws: it
 * costs its own cap and nothing else. See {@link STATUS_CALL_DEADLINE_MS} for
 * why a bound is needed at all when the transport already has one.
 *
 * Returned shape is `Record<capName, unknown | null>`; the client-
 * side hook tightens this to `CapStatusTypeMap` via the generated
 * `cap-status-types.ts`.
 */
/** True for a cap that is system-scoped AND a collection — no per-device status. */
function isSystemCollection(def: { readonly scope?: string; readonly mode?: string }): boolean {
  return def.scope === 'system' && def.mode === 'collection'
}

export async function getDeviceStatusAggregate(
  deps: AggregationDeps,
  input: {
    readonly deviceId: number
    readonly caps?: readonly string[]
  },
  options?: StatusAggregateOptions,
): Promise<Record<string, unknown | null>> {
  const deadlineMs = options?.deadlineMs ?? STATUS_CALL_DEADLINE_MS
  const capNames: readonly string[] = input.caps ?? CAP_NAMES_WITH_STATUS
  const registry = deps.capabilityRegistry
  const out: Record<string, unknown | null> = {}
  if (!registry) {
    for (const name of capNames) out[name] = null
    return out
  }

  await Promise.all(
    capNames.map(async (capName) => {
      try {
        const def = registry.getDefinition(capName)
        if (!def?.status) {
          out[capName] = null
          return
        }
        // A SYSTEM-scoped COLLECTION cap has no per-device status: with no
        // native provider, `getProviderForDevice` falls back to the FIRST
        // registered provider, so the answer is some addon's cluster-wide
        // status stamped onto this device. For `device-export` that answer
        // carried the pairing material (HomeKit setup URI, Alexa ingress
        // token) to every viewer (D634 r3). Never asked, whoever names it.
        if (isSystemCollection(def)) {
          out[capName] = null
          return
        }

        const provider = registry.getProviderForDevice<{
          getStatus?: (input: { deviceId: number }) => Promise<unknown>
        }>(capName, input.deviceId)
        if (!provider || typeof provider.getStatus !== 'function') {
          out[capName] = null
          return
        }

        const settled = await withDeadline(
          provider.getStatus({ deviceId: input.deviceId }),
          deadlineMs,
        )
        if (settled.kind === 'timed-out') {
          // A DECLARED drop. Silence here reads as "the cap was never asked",
          // which is how a 22-minute stall produced no evidence at all.
          deps.ctx.logger.warn('getDeviceStatusAggregate: cap missed its deadline, dropping', {
            tags: { deviceId: input.deviceId },
            meta: { deviceId: input.deviceId, capName, deadlineMs },
          })
          out[capName] = null
          return
        }
        const raw = settled.value
        if (raw == null) {
          out[capName] = null
          return
        }

        // Validate against the cap's own schema — single misbehaving
        // provider must not poison the rest of the aggregate.
        const parsed = def.status.schema.safeParse(raw)
        if (!parsed.success) {
          deps.ctx.logger.warn(
            'getDeviceStatusAggregate: provider returned invalid status, dropping',
            {
              tags: { deviceId: input.deviceId },
              meta: { capName, issues: parsed.error.issues.slice(0, 3) },
            },
          )
          out[capName] = null
          return
        }
        out[capName] = parsed.data
      } catch (err) {
        deps.ctx.logger.warn('getDeviceStatusAggregate: provider threw, dropping', {
          tags: { deviceId: input.deviceId },
          meta: { capName, error: errMsg(err) },
        })
        out[capName] = null
      }
    }),
  )

  return out
}

/**
 * How many devices are aggregated at once.
 *
 * The point of the batch is to collapse N round-trips into one, not to fan a
 * hundred provider calls at a registry that also serves the live path. Ten
 * devices × the status-carrying caps is already a wide call; a ten-device
 * window keeps the burst bounded while a ten-camera install still completes in
 * a single wave.
 */
const STATUS_BATCH_WINDOW = 10

/**
 * `getDeviceStatusAggregate` for a LIST of devices, in one round-trip.
 *
 * Each device is aggregated by the SAME function the single-device call uses —
 * deliberately, because that function already encodes the behaviour that
 * matters: a provider that throws or returns an invalid status yields `null`
 * for that cap instead of poisoning the result. Re-implementing the walk here
 * to "batch it properly" would mean two copies of that rule and one of them
 * eventually missing it.
 *
 * A device whose whole aggregation fails still gets an ENTRY (all caps null)
 * rather than being omitted: a caller that reads a missing key as "not
 * answered yet" would keep the previous badge on screen forever.
 *
 * ## The response is BOUNDED, and that is load-bearing
 *
 * The windows are walked SEQUENTIALLY, so before the per-cap deadline existed a
 * single unanswerable device did not merely cost its own window — it held every
 * later window behind it, and the call never returned at all. That is the whole
 * mechanism behind "one node offline and the app loads nothing": this is the
 * one call a camera list makes for every card, the client has no timeout of its
 * own, and a tRPC query that never settles is `isLoading` forever.
 *
 * The ceiling is now `ceil(devices / STATUS_BATCH_WINDOW) × STATUS_CALL_DEADLINE_MS`
 * in the worst case (a dead device in every window), and unchanged when every
 * node is healthy. It is never unbounded.
 */
export async function getDeviceStatusAggregateBatch(
  deps: AggregationDeps,
  input: {
    readonly deviceIds: readonly number[]
    readonly caps?: readonly string[]
  },
  options?: StatusAggregateOptions,
): Promise<Record<string, Record<string, unknown | null>>> {
  const out: Record<string, Record<string, unknown | null>> = {}
  // De-duplicate: a caller that passes the same id twice must not double the
  // provider calls behind its back.
  const ids = [...new Set(input.deviceIds)]

  for (let i = 0; i < ids.length; i += STATUS_BATCH_WINDOW) {
    const window = ids.slice(i, i + STATUS_BATCH_WINDOW)
    await Promise.all(
      window.map(async (deviceId) => {
        try {
          const single: { deviceId: number; caps?: readonly string[] } = { deviceId }
          if (input.caps !== undefined) single.caps = input.caps
          out[String(deviceId)] = await getDeviceStatusAggregate(deps, single, options)
        } catch (err) {
          deps.ctx.logger.warn('getDeviceStatusAggregateBatch: device aggregation threw', {
            tags: { deviceId },
            meta: { error: errMsg(err) },
          })
          out[String(deviceId)] = {}
        }
      }),
    )
  }

  return out
}

/**
 * Return the driver-specific device-settings contribution. Hub-local
 * devices call `getSettingsUISchema()` directly; forked-worker devices
 * go through the `device-ops.getSettingsSchema` cap method on the
 * numeric-id-keyed native registry.
 *
 * Returns a discriminated result so callers can distinguish three states:
 *   'ok'          – schema obtained successfully
 *   'none'        – driver genuinely has no settings schema
 *   'unavailable' – worker was unreachable after retries (transient)
 */
export async function resolveDriverConfigSchema(
  deps: AggregationDeps,
  deviceId: number,
  hubLocal: { addonId: string; device: IDevice } | null,
): Promise<DriverConfigSchemaResult> {
  if (hubLocal) {
    const schema = hubLocal.device.getSettingsUISchema()
    return schema.sections.length === 0
      ? { status: 'none' }
      : { status: 'ok', schema: toWireShape(schema) }
  }
  const ops = deps.capabilityRegistry?.getNativeProvider<IDeviceOpsProvider>('device-ops', deviceId)
  if (!ops) return { status: 'none' }

  // Attempt the cross-process call, retrying on transient Moleculer
  // errors (service not yet available, node mid-reconnect). The worker
  // typically re-registers within 1-2 s, so two retries at 750 ms
  // intervals give it ~1.5 s of recovery time without blocking the UI
  // for longer than a single render cycle.
  const MAX_RETRIES = 2
  const RETRY_DELAY_MS = 750

  let lastErr: unknown
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_DELAY_MS)
    }
    try {
      const schema = await ops.getSettingsSchema({ deviceId })
      if (!schema) return { status: 'none' }
      const wire = schema as ConfigUISchemaWithValues
      return wire.sections.length === 0
        ? { status: 'none' }
        : { status: 'ok', schema: toWireShape(wire) }
    } catch (err: unknown) {
      lastErr = err
      // Only retry on transient Moleculer errors (retryable flag set by
      // ServiceNotAvailableError, ServiceNotFoundError, BrokerDisconnectedError).
      // A permanent error (e.g. the provider threw intentionally) breaks
      // out of the retry loop immediately.
      const isTransient = isTransientMoleculerError(err)
      if (!isTransient) break
      if (attempt < MAX_RETRIES) {
        deps.ctx.logger.debug('cross-process getSettingsSchema transient failure, retrying', {
          tags: { deviceId },
          meta: { attempt: attempt + 1, maxRetries: MAX_RETRIES, error: errMsg(err) },
        })
      }
    }
  }

  const msg = errMsg(lastErr)
  deps.ctx.logger.warn(
    'cross-process getSettingsSchema failed after retries — driver settings temporarily unavailable',
    {
      tags: { deviceId },
      meta: { error: msg },
    },
  )
  return { status: 'unavailable' }
}

/**
 * Provider surface for a `derived-form` device-config cap's save path.
 * Exactly one of `setProfile` / `setSettings` is present on the actual
 * bound provider — which one is present tells us how to route the
 * patch. `stream-params` exposes `setProfile` (profile axis); `day-night`
 * / `image-settings` expose `setSettings` (no profile axis). Never branch
 * on the cap name here — the method surface is the source of truth.
 */
export interface DerivedFormSaveSurface {
  setProfile?: (input: {
    deviceId: number
    profile: StreamProfile
    patch: StreamProfilePatch
  }) => Promise<void>
  setSettings?: (input: { deviceId: number; settings: Record<string, unknown> }) => Promise<void>
}

/**
 * Route a `derived-form` device-config cap's flat form patch to whichever
 * mutation the bound provider actually exposes — inspecting the
 * provider's method surface, not the cap name. `setSettings` fires once
 * with the parsed flat patch; `setProfile` fans the patch out per-profile
 * via the registered builderId reducer.
 */
export async function dispatchDerivedFormSave(
  builderId: string,
  deviceId: number,
  patch: Record<string, unknown>,
  dcProvider: DerivedFormSaveSurface,
  capName: string,
): Promise<void> {
  if (typeof dcProvider.setSettings === 'function') {
    const settings = parseDerivedFormSettingsPatch(builderId, patch)
    await dcProvider.setSettings({ deviceId, settings })
    return
  }
  if (typeof dcProvider.setProfile === 'function') {
    const setProfile = dcProvider.setProfile
    await applyDerivedFormProfilePatch(builderId, patch, (profile, profilePatch) =>
      setProfile({ deviceId, profile, patch: profilePatch }),
    )
    return
  }
  throw new Error(
    `[device-manager] device-config cap "${capName}" provider exposes neither setSettings nor setProfile`,
  )
}

export async function updateDeviceField(
  deps: AggregationDeps,
  input: {
    deviceId: number
    writerCapName: string
    writerAddonId: string
    key: string
    value: unknown
  },
): Promise<{ success: true }> {
  // Single-field entry point — a thin wrapper over the ONE routing function
  // `applyGroupPatch` so the single-field and batch save paths can never
  // drift (a reserved-key or D14 special-case added in one place covers
  // both). `applyGroupPatch` throws on failure; this path re-surfaces it.
  await applyGroupPatch(deps, input.deviceId, {
    writerCapName: input.writerCapName,
    writerAddonId: input.writerAddonId,
    patch: { [input.key]: input.value },
  })
  return { success: true as const }
}

/**
 * Dispatch a device custom action. Hub-local devices run it directly;
 * forked/remote devices route through the `device-ops` native cap
 * (`runAction`) — the same hub-local-then-device-ops fan-out that
 * `updateDeviceField` uses for `applySettingsPatch`.
 */
export async function dispatchDeviceAction(
  deps: AggregationDeps,
  deviceId: number,
  action: string,
  input: unknown,
): Promise<unknown> {
  const hubRegistry = deps.ctx.kernel?.deviceRegistry
  const found = hubRegistry ? resolveDeviceById(hubRegistry, deviceId) : null
  if (found) {
    return found.device.runDeviceAction(action, input)
  }
  const ops = deps.capabilityRegistry?.getNativeProvider<IDeviceOpsProvider>('device-ops', deviceId)
  if (!ops) {
    throw new Error(
      `[device-manager] device "${deviceId}" not found for runDeviceAction (no hub-local entry, no device-ops native provider)`,
    )
  }
  return ops.runAction({ deviceId, action, input })
}

/**
 * Resolve the `DeviceSettingsContribution` provider that owns a tagged
 * field. The `writerAddonId` on a tagged field equals `entry.providerAddonId`
 * from the binding that produced it — for `kind:'wrapped'` entries, that is
 * the wrapper addon id (e.g. 'snapshot-addon'); for native-only entries,
 * the system addon id.
 *
 * Resolution order (Bug-3 fix):
 *  1. `getProviderByAddon(capName, writerAddonId)` — resolves the
 *     system-registered provider by the addon id from the tagged field.
 *     For wrapper bindings (snapshot, motion-detection, etc.) this directly
 *     returns the wrapper provider, bypassing the native-first resolution
 *     order of `getProviderForDevice` that caused "method not found".
 *  2. `getSingleton(capName)` — fallback for stale/mismatched writerAddonIds.
 *     The active singleton handles the contribution even if the addonId
 *     stored in the field is out of date (e.g. after an addon rename).
 *
 * `getProviderForDevice` is intentionally NOT used here: it returns the
 * per-device native first when present (e.g. Reolink/ONVIF), and the native
 * does NOT implement contribution methods — the root cause of Bug-3.
 */
export function resolveContributionProvider(
  registry: ICapabilityRegistry,
  _def: CapabilityDefinition,
  writerCapName: string,
  writerAddonId: string,
  deviceId: number,
): DeviceSettingsContribution {
  // Primary: resolve via the exact system-registered provider for this addon.
  const byAddon = registry.getProviderByAddon<DeviceSettingsContribution>(
    writerCapName,
    writerAddonId,
  )
  if (byAddon) return byAddon
  // Fallback: active singleton — handles stale/mismatched writerAddonId.
  const singleton = registry.getSingleton<DeviceSettingsContribution>(writerCapName)
  if (singleton) return singleton
  throw new Error(
    `[device-manager] no provider for cap "${writerCapName}" (addon "${writerAddonId}") on device ${deviceId}`,
  )
}

/**
 * Batched counterpart of `updateDeviceField`. Groups changes by
 * `(writerCapName, writerAddonId)` so each contributor receives a
 * single `applyDeviceSettingsPatch` with all of its updates merged —
 * avoids N round-trips for simultaneous edits in the same save.
 *
 * Per-provider failures are captured in the `failures[]` output so the
 * admin UI can highlight which sections didn't persist; a failure on
 * one provider does NOT abort the others.
 */
export async function updateDeviceFieldsBatch(
  deps: AggregationDeps,
  input: {
    deviceId: number
    changes: ReadonlyArray<{
      writerCapName: string
      writerAddonId: string
      key: string
      value: unknown
    }>
  },
): Promise<{
  success: true
  failures: { writerCapName: string; writerAddonId: string; error: string }[]
}> {
  // Group by `(writerCapName, writerAddonId)` so we fire at most one
  // applyDeviceSettingsPatch per contributing provider.
  const groups = new Map<
    string,
    { writerCapName: string; writerAddonId: string; patch: Record<string, unknown> }
  >()
  for (const change of input.changes) {
    const key = `${change.writerCapName}::${change.writerAddonId}`
    const existing = groups.get(key)
    if (existing) {
      existing.patch[change.key] = change.value
    } else {
      groups.set(key, {
        writerCapName: change.writerCapName,
        writerAddonId: change.writerAddonId,
        patch: { [change.key]: change.value },
      })
    }
  }

  const failures: { writerCapName: string; writerAddonId: string; error: string }[] = []
  for (const group of groups.values()) {
    try {
      await applyGroupPatch(deps, input.deviceId, group)
    } catch (err: unknown) {
      failures.push({
        writerCapName: group.writerCapName,
        writerAddonId: group.writerAddonId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { success: true as const, failures }
}

/** Apply a single grouped patch to the appropriate provider. Mirrors
 * `updateDeviceField` routing (special-case device-manager, else
 * registry lookup). Used by `updateDeviceFieldsBatch`.
 *
 * Whatever the outcome, the contribution cache is told the provider was
 * written to: a write that threw may still have landed part of its patch, and
 * either way the answer cached for the panel is the PRE-write view. Serving it
 * on the read-back is the operator's "it snapped back, I had to change it
 * twice" (see `ContributionCache.markWritten`). */
export async function applyGroupPatch(
  deps: AggregationDeps,
  deviceId: number,
  group: { writerCapName: string; writerAddonId: string; patch: Record<string, unknown> },
): Promise<void> {
  try {
    await applyGroupPatchUnmarked(deps, deviceId, group)
  } finally {
    contributionCache.markWrittenWhere(
      (key) =>
        key.startsWith(`${String(deviceId)}:`) &&
        key.endsWith(`:${group.writerCapName}:${group.writerAddonId}`),
    )
  }
}

async function applyGroupPatchUnmarked(
  deps: AggregationDeps,
  deviceId: number,
  group: { writerCapName: string; writerAddonId: string; patch: Record<string, unknown> },
): Promise<void> {
  if (group.writerCapName === 'device-manager') {
    // The device-manager writer carries the DRIVER's own fields (the base
    // device section). The device-store keys it once split out here — the
    // linked-devices section's — are written by the `linked-devices`
    // extension slot since D655, and no section offers them any more. A page
    // opened before the upgrade can still send them; handed to the driver
    // they would be dropped without a word, so the save is REFUSED by name.
    const retired = Object.keys(group.patch).filter((key) => LINKED_DEVICES_RESERVED_KEYS.has(key))
    if (retired.length > 0) {
      deps.ctx.logger.warn('device-manager: a save of the retired linked-devices section refused', {
        tags: { deviceId },
        meta: { keys: retired },
      })
      throw new Error(
        `[device-manager] ${retired.join(', ')} can no longer be saved from the settings ` +
          `section — reload the page and use the Extensions section`,
      )
    }
    // A secret's keychain view (an untouched field) never reaches the driver,
    // and an explicit clear reaches it as '' while the door removes the
    // stored value (D789 for device forms).
    await applyDriverFormPatch({
      patch: group.patch,
      applyToDriver: async (driverPatch) => {
        // Hub-local fast path (reshape-aware — RtspCamera's flat mainStreamUrl
        // projects onto a `streams: [{label,url}]` array here).
        const hubRegistry = deps.ctx.kernel?.deviceRegistry
        const found = hubRegistry ? resolveDeviceById(hubRegistry, deviceId) : null
        if (found) {
          await found.device.applySettingsPatch(driverPatch)
          return
        }
        // Cross-process fallback via `device-ops.setConfig` — native registry
        // is numeric-keyed.
        const ops = deps.capabilityRegistry?.getNativeProvider<IDeviceOpsProvider>(
          'device-ops',
          deviceId,
        )
        if (!ops) {
          throw new Error(
            `[device-manager] device "${deviceId}" not found (no hub-local entry, no device-ops native provider)`,
          )
        }
        await ops.setConfig({ deviceId, values: driverPatch })
      },
      clearSecrets: async (keys) => {
        if (!deps.deviceFormSecrets) {
          throw new Error(`[device-manager] cannot clear ${keys.join(', ')}: no keychain door`)
        }
        await deps.deviceFormSecrets.clear(deviceId, keys)
      },
    })
    return
  }

  const registry = deps.capabilityRegistry
  if (!registry) throw new Error('[device-manager] capability registry unavailable')
  const def = registry.getDefinition(group.writerCapName)

  // D14: device-config caps are framework-routed — they never expose
  // `exposesDeviceSettings`; their batch save path mirrors the single-field path.
  if (isDeviceConfigCap(def)) {
    if (def.deviceConfig.ui.kind === 'widget') {
      // Widget fields self-persist; a batch save arriving here is a no-op.
      return
    }
    // ui.kind === 'derived-form': route the merged patch through whichever
    // mutation the bound provider actually exposes (setSettings or setProfile).
    const dcProvider = registry.getProviderForDevice<DerivedFormSaveSurface>(
      group.writerCapName,
      deviceId,
    )
    if (!dcProvider) {
      throw new Error(
        `[device-manager] no provider for device-config cap "${group.writerCapName}" on device ${deviceId}`,
      )
    }
    await dispatchDerivedFormSave(
      def.deviceConfig.ui.builderId,
      deviceId,
      group.patch,
      dcProvider,
      group.writerCapName,
    )
    return
  }

  if (!def?.exposesDeviceSettings) {
    throw new Error(`[device-manager] cap "${group.writerCapName}" does not expose device settings`)
  }
  const provider = resolveContributionProvider(
    registry,
    def,
    group.writerCapName,
    group.writerAddonId,
    deviceId,
  )
  await provider.applyDeviceSettingsPatch({ deviceId, patch: group.patch })
}

export async function listWrappersForCap(
  deps: AggregationDeps,
  input: { capName: string },
): Promise<string[]> {
  return [...(deps.capabilityRegistry?.getWrappersForCap(input.capName) ?? [])]
}

export async function listBindableCapsForDeviceType(
  deps: AggregationDeps,
  input: {
    deviceType: string
  },
): Promise<Array<{ capName: string; wrappers: string[] }>> {
  const registry = deps.capabilityRegistry
  if (!registry) return []
  const capNames = registry.listDeviceScopedCapsForType(input.deviceType)
  return capNames.map((capName) => ({
    capName,
    wrappers: [...registry.getWrappersForCap(capName)],
  }))
}

/*
 * `setWrapperActive` moved to `device-source-activation.ts` (D556): the verb
 * now also owns the per-device SOURCE deny list and the mirror that puts it on
 * the resolution path, and it needs a narrower dependency bag than
 * `AggregationDeps` to do it.
 */

/** One wireable-cap entry of the `getWireableFields` wire shape. */
interface WireableCapEntry {
  cap: string
  fields: Array<{
    path: string
    kind: WireableField['kind']
    enumValues?: string[]
    item?: boolean
    quantity?: WireableField['quantity']
  }>
  itemArray?: { path: string; keyField: string }
}

/**
 * Build the wireable-cap entry for one capability definition: the status
 * schema's scalar leaf fields plus — for an item-array cap
 * (`status.itemArray`) — the per-item fields tagged `item: true` (a link
 * targeting one must carry a `target.itemKey`) and the cap-level `itemArray`
 * descriptor so the UI can address items. Returns null when the cap exposes
 * nothing wireable (no status schema / no leaf fields).
 */
function wireableEntryForDef(capName: string, def: CapabilityDefinition): WireableCapEntry | null {
  const status = def.status
  const schema = status?.schema
  if (!schema) return null
  const itemArray = status.itemArray
  // `enumerateSchemaFields` yields `readonly string[]` enum values;
  // the cap contract wants a mutable `string[]`, so copy each field.
  const fields = [
    ...enumerateSchemaFields(schema),
    ...(itemArray ? enumerateItemArrayFields(itemArray) : []),
  ].map((f) => ({
    path: f.path,
    kind: f.kind,
    ...(f.enumValues !== undefined ? { enumValues: [...f.enumValues] } : {}),
    ...(f.item === true ? { item: true } : {}),
    ...(f.quantity !== undefined ? { quantity: f.quantity } : {}),
  }))
  if (fields.length === 0) return null
  return {
    cap: capName,
    fields,
    ...(itemArray ? { itemArray: { path: itemArray.path, keyField: itemArray.keyField } } : {}),
  }
}

/**
 * Per-device wireable-field catalog — the domain status fields a device's
 * bound caps expose, for the operator's cross-device wiring UI. Binding-driven:
 * walks `getBindings(deviceId)`, skips wrapper caps (their status schemas are
 * internal book-keeping, not wireable domain data), and enumerates each cap's
 * status schema leaf fields (per-item fields included for item-array caps).
 *
 * `includeSynthesizable: true` (TARGET pickers only) additionally unions in
 * UNBOUND device-scoped caps that declare `status.empty` (the synthesize-target
 * marker) and whose `deviceTypes` admit this device's persisted type — so the
 * FIRST link to a synthesize-only cap (consumables on an HA vacuum) can be
 * authored before any binding exists. Default (absent/false) behavior is
 * byte-identical to the binding-driven catalog.
 */
export async function getWireableFields(
  deps: AggregationDeps,
  input: Parameters<IDeviceManagerProvider['getWireableFields']>[0],
): ReturnType<IDeviceManagerProvider['getWireableFields']> {
  const { deviceId } = input
  const reg = deps.capabilityRegistry
  if (!reg) return { caps: [] }
  const { entries } = await getBindings(deps.bindingsDeps, { deviceId })
  const seen = new Set<string>()
  const caps: WireableCapEntry[] = []
  for (const entry of entries) {
    if (seen.has(entry.capName)) continue
    seen.add(entry.capName)
    const def = reg.getDefinition(entry.capName)
    // Skip wrapper caps (snapshot, detection-pipeline, motion-detection, …)
    // auto-bound to every device — their status schemas are internal
    // book-keeping (e.g. snapshot.lastCapturedAt), not wireable domain data.
    if (!def || def.kind === 'wrapper') continue
    const wireable = wireableEntryForDef(entry.capName, def)
    if (wireable) caps.push(wireable)
  }
  if (input.includeSynthesizable === true) {
    const row = await deps.bindingsDeps.rows.get(deviceId)
    const deviceType = row?.meta.type
    if (deviceType !== undefined) {
      for (const def of ALL_CAPABILITY_DEFINITIONS) {
        if (seen.has(def.name)) continue
        if (def.scope !== 'device' || def.kind === 'wrapper') continue
        // `status.empty` is the synthesize-target marker: without it the
        // resolver has no merge base, so the cap cannot be link-built.
        //
        // ⚠ This whole branch is unreachable in production: `includeSynthesizable`
        // is never passed `true` by any caller (the automation builder, the one
        // live consumer of `getWireableFields`, asks without it), and the
        // resolver it fed was deleted with device-links on 2026-08-08. Kept
        // with the rest of that skeleton pending the operator's wiring
        // decision — marked so it is not read as working machinery.
        if (def.status?.empty === undefined) continue
        if (def.deviceTypes && !def.deviceTypes.some((t) => t === deviceType)) continue
        seen.add(def.name)
        const wireable = wireableEntryForDef(def.name, def)
        if (wireable) caps.push(wireable)
      }
    }
  }
  return { caps }
}
