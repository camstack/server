/**
 * The export targets as `integration-instances` (role `services`, D996): the operator adds,
 * edits, switches and deletes targets from the Connectivity page. A target's id is MINTED
 * (`hae_001`, ...) and names its Home Assistant connection as a reference, so several targets
 * may push to one Home Assistant.
 */
import {
  type IntegrationInstanceStatus,
  RecordIntegrationInstances,
  type RecordsAccess,
} from '@camstack/types'
import { buildTargetForm } from './target-form.js'
import {
  type ExportTargets,
  HA_TARGET_KIND,
  type HaExportTargetBody,
  haExportTargetsKind,
  newTargetBody,
  nextTargetId,
} from './target-records.js'

/** What happened to a target through the instances door. */
export type TargetChange = 'created' | 'updated' | 'enabled' | 'deleted'

export interface TargetInstanceDeps {
  /** The loaded records; read per call, it does not exist before the boot read. */
  readonly book: () => ExportTargets
  /** Whether the hub knows this Home Assistant connection (as of the last `broker.list`). */
  readonly connectionExists: (connectionId: string) => boolean
  readonly health: (id: string, body: HaExportTargetBody) => IntegrationInstanceStatus
  /** Runs after every change, once the records are reloaded by the caller. */
  readonly onChanged: (id: string, change: TargetChange) => Promise<void>
}

export function openTargetInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: TargetInstanceDeps,
): RecordIntegrationInstances<HaExportTargetBody> {
  return new RecordIntegrationInstances(records, haExportTargetsKind, {
    description: {
      role: 'services',
      instanceMode: 'multiple',
      kind: 'target',
      canTest: false,
      kinds: [{ id: HA_TARGET_KIND, label: 'Home Assistant', functionCap: 'device-export' }],
    },
    formSchema: () => buildTargetForm(),
    initialBody: (name): HaExportTargetBody => newTargetBody(name),
    mintId: () => nextTargetId(deps.book().ids()),
    kindOf: () => HA_TARGET_KIND,
    health: (body, id) => ({ status: deps.health(id, body) }),
    // A target without an existing connection is unconfigured: it pushes nothing and KEEPS its
    // devices. It is never a reason to unexpose.
    configured: (body) => deps.connectionExists(body.connectionId),
    onChanged: deps.onChanged,
  })
}
