/**
 * The link to a layout template on System → Templates, with the editor already
 * on that template (`?edit=<templateId>`).
 */
export const TEMPLATE_EDIT_PARAM = 'edit'

export function templateEditPath(templateId: string): string {
  return `/system/templates?${TEMPLATE_EDIT_PARAM}=${encodeURIComponent(templateId)}`
}
