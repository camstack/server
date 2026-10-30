import type { ConfigUISchema, TerminalProfileInfo } from '@camstack/types'

export interface SpawnDraft {
  readonly executable: string
  readonly args: string
  readonly cwd: string
  readonly environment: string
}

export function joinLines(values: readonly string[] | undefined): string {
  return (values ?? []).join('\n')
}

export function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
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

export function spawnDraftFromProfile(profile: TerminalProfileInfo | undefined): SpawnDraft {
  return {
    executable: profile?.executable ?? '',
    args: joinLines(profile?.args),
    cwd: profile?.cwd ?? '',
    environment: joinLines(profile?.environment),
  }
}

/** The default name of a new terminal: `<profile> <node>`. */
export function defaultTerminalName(profileLabel: string, nodeName: string): string {
  return `${profileLabel} ${nodeName}`.trim()
}
