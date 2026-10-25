/** The picker's candidates for a source-cap kind (doorbell, motion): ONE fleet read + the cap index. */
import { type DeviceInfo, SOURCE_CAPS } from '@camstack/types'
import {
  resolveDeviceIntegration,
  useDeviceManagerListAll,
  useIntegrationsList,
} from '@camstack/ui-library'
import { useMemo } from 'react'
import { type Known, knownOf } from '../known'
import {
  type AssignmentCandidate,
  type CandidateDevice,
  sourceCandidates,
} from './assignment-candidates'
import { useCapIndex } from './use-cap-index'

/** The fields of an `integrations.list` row this module reads (structural, as in `search-items.ts`). */
interface NamedIntegration {
  readonly id: string
  readonly addonId: string
  readonly name: string
}

/** The `integrations.list` answer; undefined while unanswered (then no row is named). */
type IntegrationsAnswer = readonly NamedIntegration[] | undefined

export interface SourceCandidatesOptions {
  readonly hostId: number
  readonly excludeCameras: boolean
  readonly assigned: ReadonlySet<string>
  readonly preferredCap: string | null
  /** Only while the picker is open: the fleet is not listed for a closed dialog. */
  readonly enabled: boolean
}

function integrationName(device: DeviceInfo, integrations: IntegrationsAnswer): string | null {
  const resolution = resolveDeviceIntegration(device, integrations)
  return resolution.kind === 'resolved' ? resolution.integration.name : null
}

/** The fleet as candidate devices (listAll slim + integration names); shared by the cards to name their rows. */
export function useCandidateDevices(enabled: boolean): Known<readonly CandidateDevice[]> {
  const all = useDeviceManagerListAll({ projection: 'slim' }, { enabled })
  const { data: integrations } = useIntegrationsList(undefined, { enabled })
  const message = all.error === null || all.error === undefined ? null : all.error.message
  // The fleet is ~1 000 rows and the cards re-render on every live value: map it once per answer.
  return useMemo(
    () =>
      knownOf(
        { status: all.status, data: all.data, error: message === null ? null : { message } },
        (rows: readonly DeviceInfo[]) =>
          rows.map((d) => ({
            id: d.id,
            name: d.name,
            addonId: d.addonId,
            stableId: d.stableId,
            type: d.type,
            location: d.location,
            isCamera: d.isCamera,
            integration: integrationName(d, integrations),
            parentDeviceId: d.parentDeviceId,
            primaryChildEntityId: d.primaryChildEntityId ?? null,
            role: d.role ?? null,
          })),
      ),
    [all.status, all.data, message, integrations],
  )
}

export function useSourceCandidates(
  options: SourceCandidatesOptions,
): Known<readonly AssignmentCandidate[]> {
  const devices = useCandidateDevices(options.enabled)
  const capIndex = useCapIndex(SOURCE_CAPS, options.enabled)
  // A failure is said as soon as either read fails, even while the other is still pending.
  if (devices.kind === 'unknown') return devices
  if (capIndex.kind === 'unknown') return capIndex
  if (devices.kind === 'pending' || capIndex.kind === 'pending') return { kind: 'pending' }
  return {
    kind: 'known',
    value: sourceCandidates({
      devices: devices.value,
      capIndex: capIndex.value,
      hostId: options.hostId,
      excludeCameras: options.excludeCameras,
      assigned: options.assigned,
      preferredCap: options.preferredCap,
    }),
  }
}
