/**
 * The hub's public URL is no longer a setting of this addon (D986 §5): Google reads the
 * `publicEndpoint` role of the local-network palette on every use. The two keys older
 * versions persisted are deleted. Every other key is left exactly as stored.
 *
 * Idempotent: a store without either key yields an empty plan, which writes nothing.
 */
import { type MigrationPlan, preconditionOf } from '@camstack/types'

/** The settings scope of this addon (`<addonId>:addon-settings`). */
export const GOOGLE_SETTINGS_SCOPE = 'export-google:addon-settings'

export const RETIRED_PUBLIC_URL_KEYS: readonly string[] = ['publicHubUrl', 'detectedPublicHubUrl']

export interface DropPublicHubUrlPorts {
  /** The addon's stored settings as written, unparsed. */
  readStored(): Promise<Readonly<Record<string, unknown>>>
}

export async function planDropPublicHubUrl(ports: DropPublicHubUrlPorts): Promise<MigrationPlan> {
  const stored = await ports.readStored()
  const present = RETIRED_PUBLIC_URL_KEYS.filter((key) => key in stored)
  if (present.length === 0) return { edits: [] }
  return {
    edits: [
      {
        op: 'deleteKeys',
        scope: GOOGLE_SETTINGS_SCOPE,
        keys: [...present],
        precondition: preconditionOf(Object.fromEntries(present.map((key) => [key, stored[key]]))),
      },
    ],
  }
}
