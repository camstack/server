/**
 * The link to a template on Build → Templates, with the editor already on that
 * template (`?edit=<templateId>`).
 */
export const TEMPLATE_EDIT_PARAM = 'edit'

export function templateEditPath(templateId: string): string {
  return `/build?tab=templates&${TEMPLATE_EDIT_PARAM}=${encodeURIComponent(templateId)}`
}
