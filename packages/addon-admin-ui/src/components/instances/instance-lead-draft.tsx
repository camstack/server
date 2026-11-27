/**
 * What an editor dialog's lead (the part above the generic form: a model picker, a provider
 * widget) may do with its edits: hand them to the dialog, which sends them with its own
 * "Save changes". A lead never writes the record itself (planning#675).
 */
import { createContext, useContext } from 'react'

export type LeadValues = Readonly<Record<string, unknown>>

/** Replaces the values the lead wants saved with the record; called again on every edit. */
export type SetLeadValues = (values: LeadValues) => void

export const InstanceLeadDraftContext = createContext<SetLeadValues | null>(null)

/** The dialog's collector; a lead rendered outside an editor dialog is a wiring mistake. */
export function useInstanceLeadDraft(): SetLeadValues {
  const set = useContext(InstanceLeadDraftContext)
  if (set === null) {
    throw new Error('A dialog lead must be rendered inside InstanceEditorDialog')
  }
  return set
}
