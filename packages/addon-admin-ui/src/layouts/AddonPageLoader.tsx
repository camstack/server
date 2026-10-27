/**
 * AddonPageLoader — admin-ui side of the addon-pages system.
 *
 * Backed by Module Federation (`@module-federation/runtime`). Every page
 * addon publishes a remote at `dist/remoteEntry.js` (built by its
 * `vite.config.ts` with the `federation()` plugin). At runtime we fetch
 * the public list of addon-contributed pages via
 * `useAddonPagesListPages()`, register the remote (`registerRemotes`)
 * once per `remoteName`, then resolve the page component by loading
 * the exposed `./page` module (`loadRemote`) whose default export is
 * the React component.
 *
 * The shared MF runtime is initialized once via `ensureMfHostInit()`
 * (also used by `<WidgetRegistryProvider>`); both kinds of remote
 * inherit the host's React, react-query, tRPC, and workspace packages.
 */
import { useState, useEffect, useMemo, type ComponentType } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { registerRemotes, loadRemote } from '@module-federation/runtime'
import type { AddonPageInfo as ServerAddonPageInfo } from '@camstack/types'
import type { System } from '@camstack/sdk'
import { useAddonPagesListPages, useSystem, ensureMfHostInit } from '@camstack/ui-library'
import { hubPath } from '../lib/mount'
import { useTranslation } from 'react-i18next'
import { AddonPageBoundary, AddonPageError, AddonPageLoading } from './AddonPageFrame'

/**
 * Props passed to dynamically loaded addon page components.
 * Uses the unified `System.trpcClient` type directly to avoid cross-package
 * @trpc/client version mismatches.
 */
interface AddonPageRenderProps {
  readonly trpc: System['trpcClient']
  readonly theme: { readonly isDark: boolean }
  readonly navigate: (path: string) => void
}

export interface AddonPageInfo {
  readonly id: string
  readonly addonId: string
  readonly label: string
  readonly icon: string
  readonly path: string
  readonly remoteName: string
  readonly bundle: string
  readonly bundleUrl: string
  /** Sidebar docking (see addon-pages-source cap): well-known or custom section id. */
  readonly section?: string
  /** Label for a custom `section` id. */
  readonly sectionLabel?: string
}

/**
 * Flatten the nested tRPC response into a flat AddonPageInfo, de-duplicating
 * by `(addonId, page.id)`.
 *
 * The hub aggregator already collapses pages reported by multiple nodes, but
 * `addon-pages-source` is a collection cap: an addon deployed on the hub-local
 * child AND a remote agent registers one provider per node, each reporting the
 * same addon id + page declaration. This frontend dedup is a defensive guard
 * (e.g. against a stale cached response served before a hub redeploy) so the
 * sidebar never renders the same page twice with duplicate React keys.
 */
export function flattenPages(raw: readonly ServerAddonPageInfo[]): readonly AddonPageInfo[] {
  const seen = new Set<string>()
  const seenPaths = new Set<string>()
  // Pass 1 — entries whose provider addonId plausibly OWNS the page
  // (normalized addonId appears in the MF remoteName, e.g. `model-studio`
  // ↔ `addon_model_studio_page`). Pass 2 — the rest. This drops ghost
  // duplicates where a same-cap provider call was answered by ANOTHER
  // addon's provider (the un-hinted agent-child-forward leg): the ghost
  // carries the wrong addonId, so the owning entry wins the path slot and
  // its bundleUrl points at the correct addon.
  const owns = (item: ServerAddonPageInfo): boolean =>
    item.page.remoteName.includes(item.addonId.replace(/[^a-zA-Z0-9]+/g, '_'))
  const ordered = [...raw.filter(owns), ...raw.filter((item) => !owns(item))]
  const out: AddonPageInfo[] = []
  for (const item of ordered) {
    const key = `${item.addonId}::${item.page.id}`
    if (seen.has(key)) continue
    if (seenPaths.has(item.page.path)) continue
    seen.add(key)
    seenPaths.add(item.page.path)
    out.push({
      id: item.page.id,
      addonId: item.addonId,
      label: item.page.label,
      icon: item.page.icon,
      path: item.page.path,
      remoteName: item.page.remoteName,
      bundle: item.page.bundle,
      bundleUrl: item.bundleUrl,
      ...(item.page.section !== undefined ? { section: item.page.section } : {}),
      ...(item.page.sectionLabel !== undefined ? { sectionLabel: item.page.sectionLabel } : {}),
    })
  }
  return out
}

/**
 * How long a page may stay on its loading skeleton — the pages list pending, or
 * the remote's entry not answering — before it becomes a message in the frame.
 */
export const ADDON_PAGE_LOAD_TIMEOUT_MS = 20_000

/** `true` once `pending` has held for `ms`; resets when it clears. */
function useDeadlinePassed(pending: boolean, ms: number): boolean {
  const [passed, setPassed] = useState(false)
  useEffect(() => {
    if (!pending) {
      setPassed(false)
      return undefined
    }
    const timer = setTimeout(() => setPassed(true), ms)
    return () => clearTimeout(timer)
  }, [pending, ms])
  return passed
}

/** Process-global cache for resolved page components, keyed by `remoteName`. */
const pageComponentCache = new Map<string, ComponentType<AddonPageRenderProps>>()
const pageInflight = new Map<string, Promise<ComponentType<AddonPageRenderProps>>>()
const registeredRemotes = new Set<string>()

interface RemotePageModule {
  readonly default: ComponentType<AddonPageRenderProps>
}

function isRemotePageModule(value: unknown): value is RemotePageModule {
  if (!value || typeof value !== 'object') return false
  const def = (value as { default?: unknown }).default
  return typeof def === 'function'
}

async function loadRemotePage(
  remoteName: string,
  entryUrl: string,
): Promise<ComponentType<AddonPageRenderProps>> {
  const cached = pageComponentCache.get(remoteName)
  if (cached) return cached
  const inflight = pageInflight.get(remoteName)
  if (inflight) return inflight

  if (!registeredRemotes.has(remoteName)) {
    ensureMfHostInit()
    // The aggregator stamps `bundleUrl` relative to the hub ROOT; under a
    // path-mounted relay it has to go back under the page's mount.
    registerRemotes([{ name: remoteName, entry: hubPath(entryUrl), type: 'module' }], {
      force: false,
    })
    registeredRemotes.add(remoteName)
  }

  const promise = loadRemote<unknown>(`${remoteName}/page`)
    .then((mod): ComponentType<AddonPageRenderProps> => {
      if (!isRemotePageModule(mod)) {
        throw new Error(
          `Addon page remote ${remoteName} (${entryUrl}) does not expose a default React component on './page'`,
        )
      }
      pageComponentCache.set(remoteName, mod.default)
      pageInflight.delete(remoteName)
      return mod.default
    })
    .catch((err: unknown) => {
      pageInflight.delete(remoteName)
      throw err
    })
  pageInflight.set(remoteName, promise)
  return promise
}

export function AddonPageLoader() {
  const { t } = useTranslation()
  const { pagePath } = useParams<{ pagePath: string }>()
  const navigate = useNavigate()
  const system = useSystem()

  const {
    data: rawPages,
    isError: pagesFailed,
    error: pagesError,
  } = useAddonPagesListPages(undefined)
  const pages = useMemo<readonly AddonPageInfo[] | undefined>(
    () => (rawPages ? flattenPages(rawPages as readonly ServerAddonPageInfo[]) : undefined),
    [rawPages],
  )

  const page = pages?.find((p) => p.path === `/addon/${pagePath}`) // hub-path-ok: router path compare
  // Depend on remote identity, not the `page` object — `flattenPages` returns a
  // fresh object whenever the pages list refetches, and clearing PageComponent
  // on every identity change unmounted the remote page (draft state lost) even
  // when remoteName + bundleUrl were unchanged.
  const remoteName = page?.remoteName
  const bundleUrl = page?.bundleUrl
  const [PageComponent, setPageComponent] = useState<ComponentType<AddonPageRenderProps> | null>(
    null,
  )
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!remoteName || !bundleUrl) return
    setError(null)

    const cached = pageComponentCache.get(remoteName)
    if (cached) {
      setPageComponent(() => cached)
      return
    }

    setPageComponent(null)

    let cancelled = false
    loadRemotePage(remoteName, bundleUrl)
      .then((Component) => {
        if (cancelled) return
        setPageComponent(() => Component)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
      })
    return () => {
      cancelled = true
    }
  }, [remoteName, bundleUrl])

  const listStalled = useDeadlinePassed(!pages && !pagesFailed, ADDON_PAGE_LOAD_TIMEOUT_MS)
  const remoteStalled = useDeadlinePassed(
    page !== undefined && !PageComponent && !error,
    ADDON_PAGE_LOAD_TIMEOUT_MS,
  )

  if (!pages) {
    if (pagesFailed) {
      return (
        <AddonPageError
          message={
            pagesError?.message ??
            t('layouts.addonPageLoader.listFailed', 'The page list could not be loaded.')
          }
        />
      )
    }
    if (listStalled) {
      return (
        <AddonPageError
          message={t(
            'layouts.addonPageLoader.listStalled',
            'The hub did not send the page list. Try again in a moment.',
          )}
        />
      )
    }
    return <AddonPageLoading />
  }

  if (!page) {
    return (
      <div className="flex items-center justify-center h-full text-foreground-subtle">
        {t('layouts.addonPageLoader.addonPageNotFound', 'Addon page not found')}
      </div>
    )
  }

  if (error) return <AddonPageError message={error} />

  if (!PageComponent) {
    if (remoteStalled) {
      return (
        <AddonPageError
          message={t(
            'layouts.addonPageLoader.remoteStalled',
            'The page did not load. Its addon may be starting or unreachable.',
          )}
        />
      )
    }
    return <AddonPageLoading />
  }

  return (
    <AddonPageBoundary pageKey={page.remoteName}>
      <PageComponent
        trpc={system.trpcClient}
        theme={{ isDark: document.documentElement.classList.contains('dark') }}
        navigate={(path: string) => {
          // SPA navigation — never hard-reload the admin shell (basename-aware).
          navigate(path.startsWith('/') ? path : `/${path}`)
        }}
      />
    </AddonPageBoundary>
  )
}
