import type { AppDeclaration, AppInfo, AppNavSection, IAppSourceProvider } from '@dominevo/types'
import { settleSourcesWithTimeout } from '../shared/settle-sources.js'

/** Per-source ceiling: one dead provider must not stall the shell's app list. */
export const APPS_PER_SOURCE_TIMEOUT_MS = 2_500

export interface AppsCaller {
  readonly isAdmin: boolean
}

export interface AppsLogger {
  warn(message: string, context?: { readonly meta?: Readonly<Record<string, unknown>> }): void
}

export type AppSourceEntry = IAppSourceProvider & { readonly id: string }

function offeredTo(app: AppDeclaration, caller: AppsCaller): boolean {
  if (app.adminOnly && !caller.isAdmin) return false
  if (app.roles !== undefined && !app.roles.includes(caller.isAdmin ? 'admin' : 'user')) {
    return false
  }
  return true
}

function visibleNav(nav: readonly AppNavSection[], caller: AppsCaller): AppNavSection[] {
  return nav.map((section) => ({
    ...section,
    items: section.items.filter((item) => caller.isAdmin || item.adminOnly !== true),
  }))
}

/** Ordered apps first, ascending; an app with no `order` goes after them. */
function compareOrder(a: number | undefined, b: number | undefined): number {
  if (a === undefined) return b === undefined ? 0 : 1
  if (b === undefined) return -1
  return a - b
}

/**
 * Merge every `app-source` provider into the caller's list (D1096): stamp the
 * provider id, drop what the caller's role may not see, order by `order`.
 * A provider that fails or times out is logged with its reason and answered
 * from its last good snapshot (`lastGood`, owned by the caller) or skipped when
 * it has none. The same app reported by several nodes (a collection registers
 * one provider per node) is listed once, keyed on `(addonId, app.id)`, the
 * first provider winning: the hub-local one precedes remote ones.
 */
export async function aggregateApps(
  sources: readonly AppSourceEntry[],
  caller: AppsCaller,
  logger: AppsLogger,
  lastGood: Map<string, readonly AppDeclaration[]> = new Map(),
): Promise<readonly AppInfo[]> {
  const settled = await settleSourcesWithTimeout<AppDeclaration>(
    sources.map((source) => [source.id, () => Promise.resolve(source.listApps())] as const),
    APPS_PER_SOURCE_TIMEOUT_MS,
  )

  const out: AppInfo[] = []
  const seen = new Set<string>()
  const live = new Set<string>()
  for (const [sourceId, result] of settled) {
    live.add(sourceId)
    let declared: readonly AppDeclaration[] | undefined
    if (result.ok) {
      declared = result.value
      lastGood.set(sourceId, declared)
    } else {
      logger.warn('app-source provider failed', {
        meta: { sourceId, error: result.error.message },
      })
      declared = lastGood.get(sourceId)
      if (declared !== undefined) {
        logger.warn('app-source serving its last good snapshot', {
          meta: { sourceId, apps: declared.length },
        })
      }
    }
    for (const app of declared ?? []) {
      if (!offeredTo(app, caller)) continue
      const key = `${sourceId}::${app.id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ addonId: sourceId, app: { ...app, nav: visibleNav(app.nav, caller) } })
    }
  }

  for (const cachedId of lastGood.keys()) {
    if (!live.has(cachedId)) lastGood.delete(cachedId)
  }

  // Stable: Array.prototype.sort keeps declaration order for equal keys.
  return out.sort((a, b) => compareOrder(a.app.order, b.app.order))
}
