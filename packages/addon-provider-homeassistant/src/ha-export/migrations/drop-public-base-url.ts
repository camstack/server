/**
 * The media base is no longer a setting of this addon (D986 §5): each Home Assistant
 * instance chooses a hub address ROLE (`mediaRole:<brokerId>`) and the address is read from
 * the palette on every use. The `publicBaseUrl` key older versions persisted is deleted.
 * Every other key is left exactly as stored.
 *
 * Idempotent: a store without the key yields an empty plan, which writes nothing.
 */
import { type MigrationPlan, preconditionOf } from '@camstack/types'

/** The settings scope of this addon (`<addonId>:addon-settings`). */
export const HA_EXPORT_SETTINGS_SCOPE = 'homeassistant-export:addon-settings'

export const RETIRED_URL_KEYS: readonly string[] = ['publicBaseUrl']

export interface DropPublicBaseUrlPorts {
  /** The addon's stored settings as written, unparsed. */
  readStored(): Promise<Readonly<Record<string, unknown>>>
}

export async function planDropPublicBaseUrl(ports: DropPublicBaseUrlPorts): Promise<MigrationPlan> {
  const stored = await ports.readStored()
  const present = RETIRED_URL_KEYS.filter((key) => key in stored)
  if (present.length === 0) return { edits: [] }
  return {
    edits: [
      {
        op: 'deleteKeys',
        scope: HA_EXPORT_SETTINGS_SCOPE,
        keys: [...present],
        precondition: preconditionOf(Object.fromEntries(present.map((key) => [key, stored[key]]))),
      },
    ],
  }
}
