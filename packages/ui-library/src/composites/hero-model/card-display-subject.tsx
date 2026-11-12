/**
 * The device a hero card draws, as its readings and numeric controls are DISPLAYED:
 * its role, its display override and its chosen quantity. Read once per card
 * (`deviceManager.getDevice`, shared with the page's own query) and published to the
 * scene and the controls below it. Until it lands they use the user's unit
 * preferences alone; outside a card they see `null`.
 */
import type { SourceInfo } from '@camstack/types'
import { createContext, type ReactNode, useContext, useMemo } from 'react'
import { useDeviceManagerGetDevice } from '../../generated/system-hooks'
import type { ReadingDisplaySubject } from './measurement-display'

export interface CardDisplaySubject extends ReadingDisplaySubject {
  readonly sourceInfo?: SourceInfo
}

const CardDisplaySubjectContext = createContext<CardDisplaySubject | null>(null)

export interface CardDisplaySubjectProviderProps {
  readonly deviceId: number
  readonly children: ReactNode
}

export function CardDisplaySubjectProvider({
  deviceId,
  children,
}: CardDisplaySubjectProviderProps): ReactNode {
  const { data } = useDeviceManagerGetDevice({ deviceId }, { staleTime: 60_000 })
  const subject = useMemo<CardDisplaySubject | null>(
    () =>
      data === undefined || data === null
        ? null
        : {
            role: data.role ?? null,
            ...(data.display === undefined ? {} : { display: data.display }),
            ...(data.sourceInfo === undefined ? {} : { sourceInfo: data.sourceInfo }),
          },
    [data],
  )
  return (
    <CardDisplaySubjectContext.Provider value={subject}>
      {children}
    </CardDisplaySubjectContext.Provider>
  )
}

export function useCardDisplaySubject(): CardDisplaySubject | null {
  return useContext(CardDisplaySubjectContext)
}
