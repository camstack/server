/**
 * What an editor dialog's lead (the part above the generic form: a model picker, a provider
 * widget) may do with its edits: hand them to the dialog, which sends them with its own
 * "Save changes". A lead never writes the record itself (planning#675).
 *
 * The dialog owns the lead's draft, so the lead reads the record's LIVE values (the stored ones
 * with the form's edits and its own on top) and the last edit of a key wins: a form edit of a
 * key the lead set earlier drops the lead's value.
 */
import { createContext, useContext } from 'react'

export type LeadValues = Readonly<Record<string, unknown>>

/** Merges the values the lead wants saved into the dialog's draft; changes of one tick arrive together. */
export type PatchLeadValues = (values: LeadValues) => void

export interface InstanceLeadDraft {
  /** The record's values as the dialog would save them now: stored, then the form's edits, then the lead's. */
  readonly values: LeadValues
  readonly patch: PatchLeadValues
}

export const InstanceLeadDraftContext = createContext<InstanceLeadDraft | null>(null)

/** The dialog's collector; a lead rendered outside an editor dialog is a wiring mistake. */
export function useInstanceLeadDraft(): InstanceLeadDraft {
  const draft = useContext(InstanceLeadDraftContext)
  if (draft === null) {
    throw new Error('A dialog lead must be rendered inside InstanceEditorDialog')
  }
  return draft
}
