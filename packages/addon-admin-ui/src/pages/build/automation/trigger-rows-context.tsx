/**
 * The automation's trigger rows, for the rows that refer to them. A
 * `triggered-by` row sits anywhere in the rules or in a step's condition, far
 * from the tree it names: the editor provides the tree once, here.
 */
import type { AutomationWhen } from '@camstack/types'
import { createContext, type ReactNode, useContext, useMemo } from 'react'
import { type TriggerRow, triggerRowsOf } from './triggered-by-model'

const NO_ROWS: readonly TriggerRow[] = []
/** `null` outside an automation: a standalone action list or a scheduler has no trigger rows. */
const TriggerRowsContext = createContext<readonly TriggerRow[] | null>(null)

export interface TriggerRowsProviderProps {
  /** The automation's `when` tree. */
  readonly when: AutomationWhen
  readonly children: ReactNode
}

export function TriggerRowsProvider({ when, children }: TriggerRowsProviderProps) {
  const rows = useMemo(() => triggerRowsOf(when), [when])
  return <TriggerRowsContext.Provider value={rows}>{children}</TriggerRowsContext.Provider>
}

/** The named trigger rows of the automation being edited; empty outside one. */
export function useTriggerRows(): readonly TriggerRow[] {
  return useContext(TriggerRowsContext) ?? NO_ROWS
}

/**
 * Whether the editor around is an automation's. Outside one nothing starts the
 * run, so "started by" is not offered there (the save refuses it anyway).
 */
export function useInsideAutomation(): boolean {
  return useContext(TriggerRowsContext) !== null
}
