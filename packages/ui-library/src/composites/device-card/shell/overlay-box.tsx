/**
 * How tall an overlay (History, Remote) is. It replaces the scene in the same
 * box: filling the host's height (`fill`, the viewer's embedded card), or the
 * measured height of the scene it replaced (admin). No height means natural.
 */
import { createContext, type ReactElement, type ReactNode, useContext } from 'react'

export interface OverlayBox {
  /** The host sized the card: the overlay takes whatever the card has left. */
  readonly fill: boolean
  /** Pixels of the scene the overlay replaced; null when unmeasured. */
  readonly height: number | null
}

const OverlayBoxContext = createContext<OverlayBox>({ fill: false, height: null })

export function OverlayBoxProvider({
  value,
  children,
}: {
  readonly value: OverlayBox
  readonly children: ReactNode
}): ReactElement {
  return <OverlayBoxContext.Provider value={value}>{children}</OverlayBoxContext.Provider>
}

export function useOverlayBox(): OverlayBox {
  return useContext(OverlayBoxContext)
}
