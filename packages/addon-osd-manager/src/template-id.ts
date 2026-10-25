/**
 * Named-template ids are system-generated — never an operator text field.
 * Create uses a uuid; the editable surface is the template name.
 */

export function generateTemplateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Optional slug helper when a stable short id from the name is preferred. */
export function templateIdFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  const base = slug.length > 0 ? slug : 'template'
  return `${base}-${Date.now().toString(36)}`
}
