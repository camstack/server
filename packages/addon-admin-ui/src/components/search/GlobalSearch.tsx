/**
 * GlobalSearch — the sidebar's always-visible search entry point across
 * three domains: device, page (built-in + addon-contributed), integration.
 *
 * Data sources are all already-loaded query caches, never a new fetch per
 * keystroke:
 *   - `useDeviceManagerListAll({ projection: 'slim' })` /
 *     `useIntegrationsList(undefined)` are the SAME hooks + query keys
 *     Devices.tsx and Integrations.tsx already call, so React Query serves
 *     this from cache once either page (or a second mount of this
 *     component) has fetched it. The `staleTime` that makes that sharing
 *     real is NOT set here: it is per-OBSERVER, so it only works when every
 *     observer agrees, and it is therefore registered once on the query
 *     client — see `applyFleetQueryDefaults` (D274).
 *   - `navSections` (built-in pages) and `addonPages` (Module Federation
 *     pages) are passed down from AppLayout, which already computes them
 *     to render the sidebar itself — this component never re-derives them.
 *
 * Filtering/ranking is pure and lives in `lib/global-search.ts` — this
 * component only owns UI state (query, active index, panel open/closed)
 * and keyboard wiring.
 */
import {
  FALLBACK_SCOPE,
  useDeviceManagerListAll,
  useIntegrationsList,
  useSearchFieldHotkey,
  Button,
  Input,
} from '@camstack/ui-library'
import { Search, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { AddonPageInfo } from '../../layouts/AddonPageLoader'
import { filterSearchItems, flattenSearchResults, type SearchItem } from '../../lib/global-search'
import type { NavSection } from '../../lib/nav-items'
import {
  buildDeviceSearchItems,
  buildIntegrationSearchItems,
  buildPageSearchItems,
} from '../../lib/search-items'
import { SearchResultsList } from './SearchResultsList'

interface GlobalSearchProps {
  readonly navSections: readonly NavSection[]
  readonly addonPages: readonly AddonPageInfo[]
  /** Icon-only sidebar (mid-width, folded) — no room for an inline input. */
  readonly compact: boolean
  /** Fired after a result is selected — lets AppLayout close the mobile
   *  drawer, mirroring every other sidebar nav action. */
  readonly onNavigated?: () => void
}

export function GlobalSearch({ navSections, addonPages, compact, onNavigated }: GlobalSearchProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  /** The portalled results panel — outside `containerRef`'s subtree. */
  const panelRef = useRef<HTMLDivElement | null>(null)
  /**
   * Where to draw the results panel, in VIEWPORT coordinates.
   *
   * The panel is portalled to `<body>`, so it needs the input's rect rather
   * than the `absolute` offsets it used to inherit. Recomputed on open, on
   * every keystroke (the panel's height changes, not its anchor, but the
   * sidebar can fold underneath it) and on resize / scroll — never on a timer.
   */
  const [anchor, setAnchor] = useState<{
    left: number
    top: number
    width: number
  } | null>(null)

  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  // Meaningful in both modes: in compact mode it toggles the floating
  // panel's existence; in full-width mode it toggles the results dropdown
  // (gated together with a non-blank query — see the render below).
  const [panelOpen, setPanelOpen] = useState(false)

  // Identical query key + input to Devices.tsx / Integrations.tsx — this
  // subscribes to (and, if neither page has mounted yet, lazily seeds) the
  // shared React Query cache. Never a per-keystroke round-trip. No options:
  // `staleTime` is a per-OBSERVER setting, not a property of the cache entry,
  // so leaving it to each call site meant any one of the 26 could re-trigger
  // a fetch of the shared key regardless of what the others passed. It is
  // registered once on the query client instead (D274).
  const { data: rawDevices } = useDeviceManagerListAll({ projection: 'slim' })
  const { data: rawIntegrations } = useIntegrationsList(undefined)

  const items = useMemo<readonly SearchItem[]>(() => {
    const pageLabels = {
      detection: t('nav.detectionSection', 'Detection'),
      cluster: t('nav.clusterSection', 'Cluster'),
      administration: t('system.title', 'Administration'),
      ungrouped: t('nav.addonPages', 'Addon Pages'),
    }
    return [
      ...buildDeviceSearchItems(rawDevices ?? [], rawIntegrations ?? null),
      ...buildPageSearchItems(navSections, addonPages, pageLabels),
      ...buildIntegrationSearchItems(rawIntegrations ?? []),
    ]
  }, [rawDevices, rawIntegrations, navSections, addonPages, t])

  const { groups, totalMatched, truncated } = useMemo(
    () => filterSearchItems(items, query),
    [items, query],
  )
  const flatResults = useMemo(() => flattenSearchResults(groups), [groups])

  // The result set just changed under the operator's feet (new keystroke,
  // or the underlying data refetched) — the previous activeIndex may now
  // point at a different row or nothing at all. Snap back to the top match.
  useEffect(() => {
    setActiveIndex(0)
  }, [query, items])

  // Focus follows `panelOpen` rather than the click/keydown handler that
  // set it, so it fires AFTER React commits the compact panel's input into
  // the DOM (it doesn't exist yet at click time in compact mode).
  useEffect(() => {
    if (panelOpen) inputRef.current?.focus()
  }, [panelOpen])

  const closePanel = useCallback(() => {
    setPanelOpen(false)
    setQuery('')
    setActiveIndex(0)
  }, [])

  const selectItem = useCallback(
    (item: SearchItem) => {
      navigate(item.path)
      closePanel()
      inputRef.current?.blur()
      onNavigated?.()
    },
    [navigate, closePanel, onNavigated],
  )

  // Cmd/Ctrl+K and Cmd/Ctrl+F reach this box only when the page has no search
  // field of its own: it registers as the fallback, so a field on the page (or
  // in an open dialog) wins and the browser's find is not stolen twice.
  useSearchFieldHotkey(inputRef, { scope: FALLBACK_SCOPE })

  // Click-outside closes an open panel (compact float, or a full-width
  // dropdown left open after a blur-less mouse click elsewhere).
  useEffect(() => {
    if (!panelOpen) return
    function onDocMouseDown(e: MouseEvent) {
      // BOTH subtrees. The results panel is portalled to `<body>`, so a click
      // on a result is no longer inside `containerRef` — checking only that
      // would close the panel on mousedown and swallow the very click that was
      // choosing a result.
      if (!(e.target instanceof Node)) return
      const insideInput = containerRef.current?.contains(e.target) === true
      const insidePanel = panelRef.current?.contains(e.target) === true
      if (!insideInput && !insidePanel) setPanelOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [panelOpen])

  const panelVisible = panelOpen && query.trim().length > 0
  useEffect(() => {
    if (!panelVisible) {
      setAnchor(null)
      return
    }
    const measure = (): void => {
      const rect = inputRef.current?.getBoundingClientRect()
      if (!rect) return
      setAnchor({ left: rect.left, top: rect.bottom + 4, width: rect.width })
    }
    measure()
    window.addEventListener('resize', measure)
    // `capture` so a scroll in ANY ancestor is seen, not only the window's:
    // the sidebar's own `<nav>` scrolls, and the input rides above it.
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [panelVisible])

  const activeKey = flatResults[activeIndex]?.key ?? null
  const placeholder = t('search.placeholder', 'Search devices, pages, integrations…')

  const inputBlock = (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground-subtle" />
      <Input
        ref={inputRef}
        type="text"
        value={query}
        placeholder={placeholder}
        aria-label={placeholder}
        role="combobox"
        aria-expanded={panelOpen && query.trim().length > 0}
        aria-controls="global-search-results"
        onChange={(e) => {
          setQuery(e.target.value)
          setPanelOpen(true)
        }}
        onFocus={() => setPanelOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            if (flatResults.length > 0) setActiveIndex((i) => (i + 1) % flatResults.length)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            if (flatResults.length > 0) {
              setActiveIndex((i) => (i - 1 + flatResults.length) % flatResults.length)
            }
          } else if (e.key === 'Enter') {
            e.preventDefault()
            const active = flatResults[activeIndex]
            if (active) selectItem(active)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            closePanel()
            inputRef.current?.blur()
          }
        }}
        className="w-full rounded-md border border-border bg-surface py-1.5 pl-7 pr-6 text-[12px] text-foreground placeholder:text-foreground-subtle/70 focus:outline-none focus:ring-1 focus:ring-primary/50"
      />
      {query.length > 0 && (
        <Button
          variant="unstyled"
          type="button"
          aria-label={t('search.globalSearch.clearSearch', 'Clear search')}
          onClick={() => {
            setQuery('')
            inputRef.current?.focus()
          }}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 text-foreground-subtle hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </Button>
      )}
      {panelVisible &&
        anchor !== null &&
        createPortal(
          <div
            ref={panelRef}
            id="global-search-results"
            // Sized to its CONTENT, not to the sidebar, and rendered in a PORTAL
            // so nothing between here and `<body>` can crop it.
            //
            // It used to be `absolute` inside the sidebar with a comment saying
            // "nothing clips it: the `<aside>` sets no overflow". That was true
            // about `overflow` and wrong about the outcome: the aside carries
            // `backdrop-blur-sm`, and an element with a `backdrop-filter` becomes
            // the containing block for its absolutely-positioned descendants and
            // paints them into its own compositing surface — so the panel was cut
            // dead at the 192px sidebar edge and every subtitle ended mid-word
            // (`#640 · mac-948cd7f85483 · c`), which is precisely the identifying
            // half of the line. A leftover comment that describes the right
            // design reads as verification; the portal is what actually delivers
            // it.
            //
            // `min-w` keeps it at least as wide as the input, `max-w` stops a
            // pathological name from spanning the app.
            className="fixed z-50 w-max max-w-[26rem] rounded-lg border border-border bg-surface shadow-xl"
            style={{ left: anchor.left, top: anchor.top, minWidth: anchor.width }}
          >
            <SearchResultsList
              groups={groups}
              activeKey={activeKey}
              query={query}
              totalMatched={totalMatched}
              truncated={truncated}
              onSelect={selectItem}
              onHover={(item) => {
                const idx = flatResults.findIndex((r) => r.key === item.key)
                if (idx >= 0) setActiveIndex(idx)
              }}
            />
          </div>,
          document.body,
        )}
    </div>
  )

  if (!compact) {
    return (
      <div ref={containerRef} className="px-2 pb-2">
        {inputBlock}
      </div>
    )
  }

  // Compact (icon-only) sidebar: no room for an inline input at 48px, so
  // show a trigger button; activating it (click, or Ctrl/Cmd+K from
  // anywhere) floats the same input+dropdown just right of the sidebar.
  // `left-14`/`top-14` line up with AppLayout's own `w-12` compact-sidebar
  // width and `h-14` header height.
  return (
    <div ref={containerRef} className="px-1.5 pb-1.5">
      {panelOpen ? (
        // `position: fixed` resolves against the VIEWPORT, so it bypasses the
        // `env(safe-area-inset-*)` padding that AppLayout puts on the shell.
        // Under `viewport-fit=cover` that viewport starts BEHIND the notch —
        // and that is how the restart toast ended up on top of the status clock.
        <div
          // Same content-sizing as the docked panel above — the folded
          // sidebar has even less room to lend, so a fixed `w-72` truncated
          // harder than the expanded one it replaces.
          className="fixed z-50 w-max min-w-72 max-w-[26rem]"
          style={{
            left: 'calc(env(safe-area-inset-left) + 3.5rem)',
            top: 'calc(env(safe-area-inset-top) + 3.5rem)',
          }}
        >
          {inputBlock}
        </div>
      ) : (
        <Button
          variant="unstyled"
          type="button"
          onClick={() => setPanelOpen(true)}
          aria-label={placeholder}
          title={placeholder}
          className="flex w-full items-center justify-center rounded-md px-0 py-2 text-foreground-subtle hover:bg-surface-hover hover:text-foreground transition-colors"
        >
          <Search className="h-3.5 w-3.5 shrink-0" />
        </Button>
      )}
    </div>
  )
}
