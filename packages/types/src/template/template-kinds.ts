/**
 * Template kinds (D963). A template is a named, reusable piece of operator
 * data that more than one device points at — today the button grid of a
 * remote. The store is generic: it keeps `{ id, kind, name, payload }` and
 * knows nothing of a remote. Only the SYSTEM declares kinds, here: each kind
 * names the schema its payload must satisfy. Adding a kind is adding a member
 * to `TEMPLATE_KINDS` and a payload schema; the compiler refuses one without
 * the other.
 */
import { z } from 'zod'
import { RemoteLayoutPayloadSchema } from '../remote/remote-config.js'

export const TEMPLATE_KINDS = ['remote'] as const
export const TemplateKindSchema = z.enum(TEMPLATE_KINDS)
export type TemplateKind = z.infer<typeof TemplateKindSchema>

export const TEMPLATE_PAYLOAD_SCHEMAS: Readonly<Record<TemplateKind, z.ZodType>> = {
  remote: RemoteLayoutPayloadSchema,
}

export function isTemplateKind(value: string): value is TemplateKind {
  return TemplateKindSchema.safeParse(value).success
}

export type TemplatePayloadCheck =
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly detail: string }

/** The payload as the kind's schema reads it, or why it is not one. */
export function checkTemplatePayload(kind: TemplateKind, payload: unknown): TemplatePayloadCheck {
  const parsed = TEMPLATE_PAYLOAD_SCHEMAS[kind].safeParse(payload)
  if (parsed.success) return { ok: true, payload: parsed.data }
  return { ok: false, detail: parsed.error.issues.map((i) => i.message).join('; ') }
}
