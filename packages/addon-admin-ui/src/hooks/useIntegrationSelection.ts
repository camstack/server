/**
 * The `?integration=` / `?section=` selection, bound to the address bar.
 *
 * Resolution is pure (`lib/integration-hub-url.ts`); this is only the router
 * binding. The selection is derived from the URL every render, never mirrored
 * into state: a second copy would disagree with the address bar the moment an
 * integration is uninstalled, and back/forward would stop meaning anything.
 *
 * Choosing an integration is a NAVIGATION, so it pushes a history entry —
 * unlike `?node=` and `AdminTabs`' `?tab=`, which replace. The operator asked
 * for back/forward to walk the integrations he opened (D774); a node pick is a
 * filter over one page, an integration is a different page's worth of content.
 */
import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'

import {
  INTEGRATION_PARAM,
  SECTION_PARAM,
  resolveIntegrationSelection,
  selectIntegrationParams,
  type IntegrationSelection,
} from '../lib/integration-hub-url'

export interface IntegrationSelectionOptions {
  readonly ids: readonly string[]
  readonly answered: boolean
  /** Connectivity's pre-hub `?tab=<kind>` links, still honoured. */
  readonly legacyGroupParam?: string | null
  readonly groupFirst?: Readonly<Record<string, string>>
}

export interface IntegrationUrlSelection extends IntegrationSelection {
  /** The section the URL asked for, or null. */
  readonly requestedSection: string | null
  /** The relative href (`?…`) that opens `integrationId` (and a section). */
  readonly hrefFor: (integrationId: string, section?: string) => string
}

export function useIntegrationSelection(
  options: IntegrationSelectionOptions,
): IntegrationUrlSelection {
  const { ids, answered, legacyGroupParam = null, groupFirst } = options
  const [searchParams] = useSearchParams()
  const requested = searchParams.get(INTEGRATION_PARAM)
  const legacyGroup = legacyGroupParam !== null ? searchParams.get(legacyGroupParam) : null
  const requestedSection = searchParams.get(SECTION_PARAM)

  const selection = useMemo(
    () =>
      resolveIntegrationSelection({
        ids,
        requested,
        answered,
        legacyGroup,
        ...(groupFirst !== undefined ? { groupFirst } : {}),
      }),
    [ids, requested, answered, legacyGroup, groupFirst],
  )

  const hrefFor = useMemo(
    () =>
      (integrationId: string, section?: string): string =>
        `?${selectIntegrationParams(searchParams, integrationId, legacyGroupParam, section ?? null).toString()}`,
    [searchParams, legacyGroupParam],
  )

  return { ...selection, requestedSection, hrefFor }
}
