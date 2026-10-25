/**
 * The catalog and preview reads for the placeholder picker.
 *
 * `useTemplateCatalog` fetches the declared `{{var}}` vocabulary once (5 min
 * stale) and lets `varsForContext` (local, see `template-field.helpers.ts`)
 * do the filtering. `useTemplatePreview` renders the operator's DRAFT through
 * the hub's own text catalog, debounced — the only honest preview, since a
 * second local renderer would drift from `render-template.ts`.
 *
 * `previewTemplate` is a MUTATION on the wire (`notification-rules.cap.ts`,
 * `kind: 'mutation'`) purely for transport (a long draft in a batched GET URL
 * risks length limits) — `access` stays `'view'`, same as `getTemplateCatalog`.
 * It is still driven like a read here: `useQuery` with a debounced key, not
 * `useMutation`.
 *
 * Only type imports are needed from `@camstack/types` here. (A runtime one
 * would also be safe: the admin UI is the Module-Federation HOST and bundles
 * `@camstack/types` from the workspace — see `template-field.helpers.ts`.)
 */
import type {
  NcTemplateVarContext,
  NcTemplateVarDescriptor,
  NcTemplatePreview,
} from '@camstack/types'
import { restoreHeldBackKinds, restoreHeldBackVars } from './template-field.helpers'
import { useDebouncedString, useSystem } from '@camstack/ui-library'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'

export const TEMPLATE_CATALOG_QUERY_KEY = ['nc', 'template-catalog'] as const
const PREVIEW_DEBOUNCE_MS = 400

/**
 * The draft text a field editor holds, before it is wrapped in the full
 * `previewTemplate` context. Deliberately NOT named `NcTemplatePreviewInput`:
 * `@camstack/types` already exports that name for the full wire input
 * (`{ context, template: { title?, body? } }`) — reusing it here for this
 * flatter, field-local shape would read as the same type under two shapes.
 */
export interface TemplatePreviewDraft {
  readonly title?: string
  readonly body?: string
}

export function useTemplateCatalog(): UseQueryResult<readonly NcTemplateVarDescriptor[]> {
  const system = useSystem()
  return useQuery({
    queryKey: TEMPLATE_CATALOG_QUERY_KEY,
    staleTime: 5 * 60_000,
    // The hub holds back kinds the installed viewers cannot parse; this admin
    // can, so it restores them (D642 review M3).
    // …and the state-summary vocabulary it holds back whole (D647).
    queryFn: async () =>
      restoreHeldBackVars(
        restoreHeldBackKinds(
          (await system.trpcClient.notificationRules.getTemplateCatalog.query({})).vars,
        ),
      ),
  })
}

export function useTemplatePreview(
  context: NcTemplateVarContext,
  template: TemplatePreviewDraft,
  enabled: boolean,
): UseQueryResult<NcTemplatePreview> {
  const system = useSystem()
  const title = useDebouncedString(template.title ?? '', PREVIEW_DEBOUNCE_MS)
  const body = useDebouncedString(template.body ?? '', PREVIEW_DEBOUNCE_MS)
  return useQuery({
    queryKey: ['nc', 'template-preview', context, title, body],
    enabled: enabled && (title.length > 0 || body.length > 0),
    staleTime: 30_000,
    queryFn: () =>
      system.trpcClient.notificationRules.previewTemplate.mutate({
        context,
        template: { ...(title ? { title } : {}), ...(body ? { body } : {}) },
      }),
  })
}
