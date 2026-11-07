import type { ConfigUISchema } from '@camstack/types'

export interface SpawnDraft {
  readonly executable: string
  readonly args: string
  readonly cwd: string
  readonly environment: string
}

export function profileSettingsSchema(raw: unknown): ConfigUISchema | null {
  if (!raw || typeof raw !== 'object' || !('sections' in raw)) return null
  const schema = raw as ConfigUISchema
  if (!Array.isArray(schema.sections) || schema.sections.length === 0) return null
  return schema
}

export function defaultsFromSchema(schema: ConfigUISchema): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const section of schema.sections) {
    for (const field of section.fields) {
      if ('key' in field && 'default' in field && field.default !== undefined) {
        out[field.key] = field.default
      }
    }
  }
  return out
}
