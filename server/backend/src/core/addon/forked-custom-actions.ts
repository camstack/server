/**
 * A forked addon's custom-action catalog, as the hub REGISTERS it from the
 * descriptor its runner put in the register frame.
 *
 * ## What this replaces
 *
 * Until D444 the hub learned a forked addon's catalog by purging the require
 * cache and re-importing the addon's whole bundle INSIDE hub-main — 9 MB per
 * evaluation, once per spawn and per hot-update, ten times in one process life
 * on 2026-09-10, and not one of those evaluations exported a catalog. Every
 * one pinned the evicted graph's module-scope state (timers, listeners, pools)
 * and the only line saying so was at `debug`, which the hub does not write.
 *
 * Now the catalog travels the other way: the runner describes it (schemas
 * stripped — MsgPack cannot carry a Zod schema) in its post-init register
 * frame, and the hub registers that description with PASSTHROUGH schemas. The
 * real validation runs in the runner (`child-addon-call-dispatch.ts`), which
 * is the only process that has the schemas.
 *
 * Pure module: the conversion and the fingerprint are testable without a
 * child, a socket or a registry.
 */
import type {
  ChildCustomActionCatalogs,
  CustomActionCatalogDescriptor,
  CustomActionsSpec,
} from '@camstack/types'
import { z } from 'zod'

/**
 * Build the hub-side catalog for a forked addon.
 *
 * `input`/`output` are `z.unknown()` ON PURPOSE: the hub's
 * `dispatchCustomAction` parses input and output around the dispatch, and for
 * a forked addon both parses must be passthroughs — the runner owns the
 * schemas and refuses what they refuse. `kind`, `auth`, `scope` and `caller`
 * are the fields the hub actually gates on, and they arrive intact.
 */
export function toForkedCustomActionsSpec(
  descriptor: CustomActionCatalogDescriptor,
): CustomActionsSpec {
  const spec: Record<string, CustomActionsSpec[string]> = {}
  for (const [name, action] of Object.entries(descriptor)) {
    spec[name] = {
      input: z.unknown(),
      output: z.unknown(),
      kind: action.kind,
      auth: action.auth,
      scope: action.scope,
      ...(action.caller === 'required' ? { caller: 'required' as const } : {}),
    }
  }
  return spec
}

/**
 * A stable identity for a child's whole catalog set, so a re-register that
 * carries the SAME catalogs (native-cap change, reconnect — 246 re-registers in
 * 30 minutes with zero respawns, measured 2026-08-25) registers nothing and
 * logs nothing. Key order is normalised at every level: two descriptions of
 * one catalog must never fingerprint differently because a runner enumerated
 * its map in another order.
 */
export function childCatalogsFingerprint(catalogs: ChildCustomActionCatalogs): string {
  return JSON.stringify(sortKeysDeep(catalogs))
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    out[key] = sortKeysDeep(Reflect.get(value, key))
  }
  return out
}

/** What one child's register frame declared, in the form the log line prints. */
export interface ChildCatalogsSummary {
  /** `addonId:actionCount` for every addon that declares at least one action. */
  readonly withActions: readonly string[]
  /** Addon ids that declared an EMPTY catalog. Named, never implied. */
  readonly withoutActions: readonly string[]
}

export function summarizeChildCatalogs(catalogs: ChildCustomActionCatalogs): ChildCatalogsSummary {
  const withActions: string[] = []
  const withoutActions: string[] = []
  for (const addonId of Object.keys(catalogs).sort()) {
    const count = Object.keys(catalogs[addonId] ?? {}).length
    if (count > 0) withActions.push(`${addonId}:${count}`)
    else withoutActions.push(addonId)
  }
  return { withActions, withoutActions }
}
