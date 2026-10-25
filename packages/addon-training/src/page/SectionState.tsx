/**
 * Pending / error / empty / content for one query — the one place that
 * decides, so a list that has not answered is never drawn as "none" (D315).
 */
import type { ReactNode } from 'react'
import { Button, Skeleton } from '@camstack/ui-library'
import { useT } from '../i18n/index.js'
import type { AsyncState } from './use-async.js'

export interface SectionStateProps<T> {
  readonly state: AsyncState<readonly T[]>
  readonly empty: string
  readonly emptyAction?: { readonly label: string; readonly onClick: () => void }
  readonly children: (items: readonly T[]) => ReactNode
}

export function SectionState<T>({ state, empty, emptyAction, children }: SectionStateProps<T>) {
  const { t } = useT()
  if (state.status === 'pending') return <Skeleton className="h-16 w-full" />
  if (state.status === 'error') {
    return (
      <p className="text-sm text-danger">
        {t('sectionState.couldNotLoad')} {state.error}
      </p>
    )
  }
  if (state.data.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm text-foreground-muted">
        <span>{empty}</span>
        {emptyAction !== undefined && (
          <Button variant="outline" onClick={emptyAction.onClick}>
            {emptyAction.label}
          </Button>
        )}
      </div>
    )
  }
  return <>{children(state.data)}</>
}
