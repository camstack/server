/**
 * What the cells of one whole-capability link row (D1076) share: the stored
 * `capLink` feature, the server's read of it, and the devices that bind the
 * source cap (the picker's candidates and the name of the linked one). Asked
 * once per cell; react-query serves the same answer to all of them.
 */
import { DeviceType, type DeviceInfo } from '@camstack/types'
import { type CapLinkCellState, useCoreBlocksGetCapLinks } from '@camstack/ui-library'
import { useMemo } from 'react'
import type { AssignmentCandidate, CandidateDevice } from '../assignments/assignment-candidates'
import { candidateDetail } from '../assignments/assignment-candidates'
import { useCapIndex } from '../assignments/use-cap-index'
import { useCandidateDevices } from '../assignments/use-source-candidates'
import { currentComposition } from '../customization-read'
import type { Known } from '../known'
import type { CustomizationHandle } from '../use-customization'
import { capLinkCellState, type OfferedCapLink, storedCapLink } from './cap-link-edit'

/** Devices that bind `cap`, minus the host and containers, named for the picker. */
export function capLinkCandidates(
  devices: readonly CandidateDevice[],
  capIndex: ReadonlyMap<number, readonly string[]>,
  cap: string,
  hostId: number,
): readonly AssignmentCandidate[] {
  return devices
    .filter(
      (device) =>
        device.id !== hostId &&
        device.type !== DeviceType.Container &&
        (capIndex.get(device.id) ?? []).includes(cap),
    )
    .map(
      (device): AssignmentCandidate => ({
        deviceId: device.id,
        ref: { addonId: device.addonId, stableId: device.stableId },
        name: device.name,
        detail: candidateDetail(device.integration, device.location),
        meta: cap,
        caps: [cap],
        value: null,
      }),
    )
    .toSorted((a, b) => a.name.localeCompare(b.name))
}

export interface CapLinkRowFacts {
  readonly stored: ReturnType<typeof storedCapLink>
  readonly state: CapLinkCellState
  readonly candidates: Known<readonly AssignmentCandidate[]>
  /** The linked source device's candidate row; null when none is stored or it is gone. */
  readonly source: AssignmentCandidate | null
  /** The customization is answered, so a change may be planned. */
  readonly answered: boolean
}

export function useCapLinkRow(
  device: Pick<DeviceInfo, 'id'>,
  handle: CustomizationHandle,
  offered: OfferedCapLink,
): CapLinkRowFacts {
  const devices = useCandidateDevices(true)
  const index = useCapIndex([offered.link.sourceCap], true)
  const read = useCoreBlocksGetCapLinks({ deviceId: device.id })
  const stored = storedCapLink(currentComposition(handle.state), offered.cap, offered.link.id)
  const views = read.data?.status === 'ok' ? read.data.links : null
  const candidates = useMemo(
    (): Known<readonly AssignmentCandidate[]> =>
      devices.kind === 'unknown'
        ? devices
        : index.kind === 'unknown'
          ? index
          : devices.kind === 'pending' || index.kind === 'pending'
            ? { kind: 'pending' }
            : {
                kind: 'known',
                value: capLinkCandidates(
                  devices.value,
                  index.value,
                  offered.link.sourceCap,
                  device.id,
                ),
              },
    [devices, index, offered.link.sourceCap, device.id],
  )
  const source =
    stored !== null && candidates.kind === 'known'
      ? (candidates.value.find(
          (c) =>
            c.ref.addonId === stored.source.addonId && c.ref.stableId === stored.source.stableId,
        ) ?? null)
      : null
  return {
    stored,
    state: capLinkCellState(stored, views, offered),
    candidates,
    source,
    answered: handle.state.kind === 'none' || handle.state.kind === 'present',
  }
}
