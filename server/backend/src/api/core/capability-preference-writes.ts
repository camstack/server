/**
 * The ONE write order for an operator's capability preference: PERSIST, then
 * switch the live registry (D675 amendment, 2026-09-29).
 *
 * Every caller used to switch the registry first and persist second. Since
 * D675 `ConfigManager.set` awaits the settings door and REJECTS when the write
 * does not land, so that order produced a mutation that reported an error
 * while the live switch had already happened — and silently reverted at the
 * next boot, because the boot restorer reads the store the write never
 * reached. The operator saw an error for a change that was visibly in effect.
 *
 * Here a refused switch (unknown cap, wrong mode, provider not registered)
 * persists NOTHING, a failed write changes NOTHING live, and only a write that
 * landed is applied. Writes to one capability are serialised, because a
 * collection write computes its next disabled-set from the live one: two
 * toggles planned against the same base would each persist half of the
 * answer.
 *
 * Callers: `capabilities` core router (`setActiveSingleton`,
 * `clearSingletonNodeOverride` via `singletonPreferenceKey`,
 * `setCollectionEnabledProviders`) and the `addons` cap's
 * `setCapabilityProviderEnabled`.
 */
import { TRPCError } from '@trpc/server'
import type { CapabilityRegistry } from '@camstack/system'
import type { CapabilityInfo } from '@camstack/types'
import type { ConfigService } from '../../core/config/config.service'
import { persistCollectionDisabled } from './collection-preference'

/** The registry surface a preference write reads and switches. */
export type PreferenceRegistry = Pick<
  CapabilityRegistry,
  | 'listCapabilities'
  | 'setActiveSingleton'
  | 'enableCollectionProvider'
  | 'disableCollectionProvider'
>

/** The settings surface a preference write persists through. */
export type PreferenceStore = Pick<ConfigService, 'set'>

/** Why a switch was refused before anything was written. */
export interface PreferenceRefusal {
  readonly code: 'NOT_FOUND' | 'BAD_REQUEST'
  readonly message: string
}

export interface SingletonPreferenceWrite {
  readonly capability: string
  readonly addonId: string
  /** Per-node override when set; the cluster-global default otherwise. */
  readonly nodeId?: string
}

/** ConfigService key holding a singleton preference (global or per-node). */
export function singletonPreferenceKey(capability: string, nodeId?: string): string {
  return nodeId === undefined
    ? `capabilities.singleton.${capability}`
    : `capabilities.singletonNode.${capability}.${nodeId}`
}

/**
 * One write chain per capability, MODULE-LEVEL on purpose: the routers that
 * write preferences are built per request, so the chain cannot live on them.
 * It serialises only within this process — correct because only hub-main
 * mounts these routers; a second process writing preferences would need the
 * store itself to arbitrate.
 */
const writeChains = new Map<string, Promise<void>>()

/** Run `work` after every earlier write to the same capability has settled. */
async function serialised(capability: string, work: () => Promise<void>): Promise<void> {
  const previous = writeChains.get(capability) ?? Promise.resolve()
  const next = previous.then(work, work)
  const settled = next.then(
    () => undefined,
    () => undefined,
  )
  writeChains.set(capability, settled)
  try {
    await next
  } finally {
    if (writeChains.get(capability) === settled) writeChains.delete(capability)
  }
}

function findCapability(registry: PreferenceRegistry, capability: string): CapabilityInfo | null {
  return registry.listCapabilities().find((c) => c.name === capability) ?? null
}

/**
 * The refusal `setActiveSingleton` would raise, asked BEFORE anything is
 * persisted — so a switch the registry would refuse never reaches the store.
 * Reads the registry's own projection (`providers`, `perNode`), the same sets
 * `setActiveSingleton` checks.
 */
export function singletonSwitchRefusal(
  registry: PreferenceRegistry,
  write: SingletonPreferenceWrite,
): PreferenceRefusal | null {
  const cap = findCapability(registry, write.capability)
  if (cap === null) {
    return { code: 'NOT_FOUND', message: `Unknown capability: ${write.capability}` }
  }
  if (cap.mode !== 'singleton') {
    return { code: 'BAD_REQUEST', message: `"${write.capability}" is not a singleton` }
  }
  if (write.nodeId !== undefined) {
    const onNode = cap.perNode?.find((n) => n.nodeId === write.nodeId)
    if (onNode === undefined || !onNode.providers.includes(write.addonId)) {
      return {
        code: 'BAD_REQUEST',
        message: `Provider "${write.addonId}" is not available on node "${write.nodeId}" for "${write.capability}"`,
      }
    }
    return null
  }
  if (!cap.providers.includes(write.addonId)) {
    return {
      code: 'BAD_REQUEST',
      message: `Provider "${write.addonId}" is not registered for "${write.capability}"`,
    }
  }
  return null
}

function refuse(refusal: PreferenceRefusal): never {
  throw new TRPCError({ code: refusal.code, message: refusal.message })
}

/** Persist a singleton preference, then switch the registry. */
export async function writeSingletonPreference(
  store: PreferenceStore,
  registry: PreferenceRegistry,
  write: SingletonPreferenceWrite,
): Promise<void> {
  await serialised(write.capability, async () => {
    const refusal = singletonSwitchRefusal(registry, write)
    if (refusal !== null) refuse(refusal)
    await store.set(singletonPreferenceKey(write.capability, write.nodeId), write.addonId)
    await registry.setActiveSingleton(write.capability, write.addonId, write.nodeId)
  })
}

function requireCollection(registry: PreferenceRegistry, capability: string): CapabilityInfo {
  const cap = findCapability(registry, capability)
  if (cap === null) refuse({ code: 'NOT_FOUND', message: `Unknown capability: ${capability}` })
  if (cap.mode !== 'collection') {
    refuse({ code: 'BAD_REQUEST', message: `"${capability}" is not a collection` })
  }
  return cap
}

/** Switch the live registry from `current` to `next` — only after the write landed. */
function applyDisabledSet(
  registry: PreferenceRegistry,
  capability: string,
  current: ReadonlySet<string>,
  next: ReadonlySet<string>,
): void {
  for (const addonId of next) {
    if (!current.has(addonId)) registry.disableCollectionProvider(capability, addonId)
  }
  for (const addonId of current) {
    if (!next.has(addonId)) registry.enableCollectionProvider(capability, addonId)
  }
}

/** Persist one collection provider's enable/disable, then apply it live. */
export async function writeCollectionToggle(
  store: PreferenceStore,
  registry: PreferenceRegistry,
  toggle: { readonly capability: string; readonly addonId: string; readonly enabled: boolean },
): Promise<void> {
  await serialised(toggle.capability, async () => {
    const cap = requireCollection(registry, toggle.capability)
    if (!cap.providers.includes(toggle.addonId)) {
      refuse({
        code: 'BAD_REQUEST',
        message: `Provider "${toggle.addonId}" is not registered for "${toggle.capability}"`,
      })
    }
    const current = new Set(cap.disabledProviders)
    const next = new Set(current)
    if (toggle.enabled) next.delete(toggle.addonId)
    else next.add(toggle.addonId)
    await persistCollectionDisabled(store, toggle.capability, [...next])
    applyDisabledSet(registry, toggle.capability, current, next)
  })
}

/**
 * Persist the enabled set of a collection in one shot, then apply it live.
 * Registered providers outside `enabledAddonIds` are disabled; a disabled id
 * whose provider is not registered right now keeps its disabled mark.
 */
export async function writeCollectionEnabledSet(
  store: PreferenceStore,
  registry: PreferenceRegistry,
  capability: string,
  enabledAddonIds: readonly string[],
): Promise<void> {
  await serialised(capability, async () => {
    const cap = requireCollection(registry, capability)
    const wanted = new Set(enabledAddonIds)
    const current = new Set(cap.disabledProviders)
    const next = new Set(current)
    for (const providerId of cap.providers) {
      if (wanted.has(providerId)) next.delete(providerId)
      else next.add(providerId)
    }
    await persistCollectionDisabled(store, capability, [...next])
    applyDisabledSet(registry, capability, current, next)
  })
}
