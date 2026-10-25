/**
 * The declared addon icons, read ONCE for the whole signed-in app.
 *
 * Every icon in the UI (device rows, integration pills, the integration page
 * header) asks this context for a URL instead of building one: only an addon
 * whose manifest declares an `icon` gets a request. See `lib/addon-icons.ts`
 * for why guessing produced 404s.
 *
 * Outside the provider (the Showroom, tests that render one component) the map
 * is empty and every icon draws its glyph — no request, nothing broken.
 */
import { useAddonsList } from '@camstack/ui-library'
import { createContext, type ReactElement, type ReactNode, useContext, useMemo } from 'react'

import { buildAddonIconMap, resolveAddonIconPath } from '../lib/addon-icons'

/** Icons change only on an addon install/update; the Addons page refetches the list itself. */
const ICONS_STALE_MS = 5 * 60_000

const EMPTY: ReadonlyMap<string, string> = new Map()

const AddonIconsContext = createContext<ReadonlyMap<string, string>>(EMPTY)

export function AddonIconsProvider({ children }: { readonly children: ReactNode }): ReactElement {
  const { data } = useAddonsList(undefined, { staleTime: ICONS_STALE_MS })
  const icons = useMemo(() => buildAddonIconMap(data as readonly unknown[] | undefined), [data])
  return <AddonIconsContext.Provider value={icons}>{children}</AddonIconsContext.Provider>
}

/** Test seam: provide a fixed map without the tRPC query. */
export function StaticAddonIconsProvider({
  icons,
  children,
}: {
  readonly icons: ReadonlyMap<string, string>
  readonly children: ReactNode
}): ReactElement {
  return <AddonIconsContext.Provider value={icons}>{children}</AddonIconsContext.Provider>
}

/** The mount-aware icon URL for an addon id (or bare provider name), or `null` when none is declared. */
export function useAddonIconUrl(hint: string | null | undefined): string | null {
  const icons = useContext(AddonIconsContext)
  return resolveAddonIconPath(icons, hint)
}
