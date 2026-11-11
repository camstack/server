/**
 * The one-off migration of legacy automatic Terminal cameras into Terminal
 * instances.
 *
 * Before explicit instances, the addon declared one camera per node and
 * profile on its own (`terminal-camera-<node>` for BTM,
 * `terminal-camera-<node>-<profile>` otherwise). Each such camera still alive
 * becomes one instance that KEEPS its stable id, so every binding, layout and
 * recording naming it survives. The instance carries the legacy camera's node,
 * profile and name.
 *
 * Idempotent by construction: the candidate list excludes every stable id an
 * instance already declares, so a rerun with nothing left adopts nothing and
 * reports 0.
 */
import type { TerminalLegacyCamera } from '@camstack/types'
import { customAction, defineCustomActions } from '@camstack/types'
import { z } from 'zod'
import { initialTerminalBody, type TerminalBody } from './terminal-record-kinds.js'

/** The body of the instance that adopts `legacy`, keeping its camera's stable id. */
export function legacyAdoptionBody(
  legacy: TerminalLegacyCamera,
  requestedName?: string,
): TerminalBody {
  return {
    ...initialTerminalBody(requestedName?.trim() || legacy.name),
    nodeId: legacy.nodeId,
    profileId: legacy.profileId,
    profileLabel: legacy.profileLabel,
    cameraStableId: legacy.stableId,
  }
}

const AdoptedLegacyCameraSchema = z.object({
  stableId: z.string(),
  instanceId: z.string(),
  nodeId: z.string(),
  profileId: z.string(),
})

const AdoptLegacyCamerasResultSchema = z.object({
  /** How many legacy cameras became instances on this run; 0 on a rerun. */
  adopted: z.number().int().nonnegative(),
  cameras: z.array(AdoptedLegacyCameraSchema).readonly(),
})

export type AdoptedLegacyCamera = z.infer<typeof AdoptedLegacyCameraSchema>
export type AdoptLegacyCamerasResult = z.infer<typeof AdoptLegacyCamerasResultSchema>

/** What the migration needs of the addon: the candidates and one record write each. */
export interface LegacyAdoptionDeps {
  readonly listLegacy: () => Promise<readonly TerminalLegacyCamera[]>
  /** Write one new instance record; it must refuse to overwrite an existing id. */
  readonly putInstance: (id: string, body: TerminalBody) => Promise<void>
  readonly newId: () => string
}

/** Adopt every legacy camera still listed, in list order. */
export async function adoptAllLegacyCameras(
  deps: LegacyAdoptionDeps,
): Promise<AdoptLegacyCamerasResult> {
  const cameras: AdoptedLegacyCamera[] = []
  for (const legacy of await deps.listLegacy()) {
    const instanceId = deps.newId()
    await deps.putInstance(instanceId, legacyAdoptionBody(legacy))
    cameras.push({
      stableId: legacy.stableId,
      instanceId,
      nodeId: legacy.nodeId,
      profileId: legacy.profileId,
    })
  }
  return { adopted: cameras.length, cameras }
}

/** `addons.custom` catalog — `{ addonId: 'terminal', action: 'adoptLegacyCameras', input: {} }`. */
export const terminalActions = defineCustomActions({
  adoptLegacyCameras: customAction(z.object({}), AdoptLegacyCamerasResultSchema, {
    kind: 'mutation',
    auth: 'admin',
  }),
})

export type TerminalActions = typeof terminalActions
