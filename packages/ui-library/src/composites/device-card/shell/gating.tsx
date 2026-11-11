/**
 * Why a card cannot be commanded, decided ONCE by the shell (offline, or the
 * viewer has no permission) and read by every part that actuates. A scene never
 * re-implements the rule: it draws parts, and the parts ask here.
 */
import { createContext, type ReactElement, type ReactNode, useContext } from 'react'

export interface CardGating {
  /** True when no command may be sent. */
  readonly blocked: boolean
  /** The sentence the reason line and every blocked control's title show. */
  readonly reason: string | null
}

const OPEN: CardGating = { blocked: false, reason: null }
const GatingContext = createContext<CardGating>(OPEN)

export function CardGatingProvider({
  value,
  children,
}: {
  readonly value: CardGating
  readonly children: ReactNode
}): ReactElement {
  return <GatingContext.Provider value={value}>{children}</GatingContext.Provider>
}

export function useCardGating(): CardGating {
  return useContext(GatingContext)
}
