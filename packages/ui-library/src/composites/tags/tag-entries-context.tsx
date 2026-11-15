/**
 * The tag registry's answered entries for a whole list (D1054), so a row deep
 * in a table colours its chips without each row asking the registry itself.
 * Absent provider = no entries: chips fall back to the name-derived colour.
 */
import type { TagEntry } from '@camstack/types'
import { createContext, type Provider, useContext } from 'react'

const TagEntriesContext = createContext<readonly TagEntry[] | undefined>(undefined)

export const TagEntriesProvider: Provider<readonly TagEntry[] | undefined> =
  TagEntriesContext.Provider

export function useTagEntries(): readonly TagEntry[] | undefined {
  return useContext(TagEntriesContext)
}
