import type { NcTemplateVarDescriptor } from '@camstack/types'

/**
 * A small, deliberate catalog for specs that exercise the placeholder picker
 * end-to-end (the rule editor, the summary/timelapse digest fields). Shared
 * rather than redefined per spec so the one guarantee that matters —
 * `{{tiles}}` is NEVER offered, because nothing has ever supplied it (see
 * `packages/types/src/notification/template-vars.ts`) — is asserted against
 * the same shape everywhere.
 */
export const TEMPLATE_CATALOG_FIXTURE: readonly NcTemplateVarDescriptor[] = [
  {
    name: 'camera',
    label: 'Camera',
    example: 'Gate',
    group: 'subject',
    families: ['rule', 'timelapse', 'summary'],
  },
  {
    name: 'rule',
    label: 'Rule',
    example: 'Night watch',
    group: 'rule',
    families: ['rule', 'timelapse', 'summary'],
  },
  {
    name: 'events',
    label: 'Events',
    example: '4',
    group: 'digest',
    families: ['timelapse', 'summary'],
    fields: ['title', 'body'],
  },
  {
    name: 'count',
    label: 'Count',
    example: '3',
    group: 'subject',
    families: ['rule'],
    kinds: ['occupancy', 'system'],
  },
]

/** The wire shape `getTemplateCatalog` answers with. */
export function templateCatalogAnswer(
  vars: readonly NcTemplateVarDescriptor[] = TEMPLATE_CATALOG_FIXTURE,
): { vars: readonly NcTemplateVarDescriptor[] } {
  return { vars }
}
