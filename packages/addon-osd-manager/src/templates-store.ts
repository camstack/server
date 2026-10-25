/**
 * Named OSD templates — durable in the addon's own (global) store.
 */
import { type OsdNamedTemplate, OsdNamedTemplateSchema } from '@camstack/types'
import { z } from 'zod'

export const OSD_TEMPLATES_KEY = 'namedTemplates'

export const OsdNamedTemplatesSchema = z.array(OsdNamedTemplateSchema)
export type OsdNamedTemplates = z.infer<typeof OsdNamedTemplatesSchema>

export const EMPTY_TEMPLATES: OsdNamedTemplates = []

export interface TemplatesHandle {
  get(): Promise<OsdNamedTemplates>
  set(next: OsdNamedTemplates): Promise<void>
}

export function upsertNamedTemplate(
  prev: OsdNamedTemplates,
  template: OsdNamedTemplate,
): OsdNamedTemplates {
  const parsed = OsdNamedTemplateSchema.parse(template)
  const without = prev.filter((t) => t.id !== parsed.id)
  return [...without, parsed].toSorted((a, b) => a.name.localeCompare(b.name))
}

export function deleteNamedTemplate(
  prev: OsdNamedTemplates,
  templateId: string,
): OsdNamedTemplates {
  return prev.filter((t) => t.id !== templateId)
}

export function findNamedTemplate(
  templates: OsdNamedTemplates,
  templateId: string,
): OsdNamedTemplate | undefined {
  return templates.find((t) => t.id === templateId)
}
