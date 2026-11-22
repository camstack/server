/**
 * The heat pump device an energy system is linked to (D1076), read through
 * `core-blocks.getCapLinks`, and what the card takes from it: the device's
 * `heat-pump-status` slice and the day's counters from ITS history. The two
 * meters are never mixed (D224): a linked system reads only the linked device.
 */
import type { DeviceHistoryQueryManyItem } from '@camstack/types'
import { useMemo } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useCoreBlocksGetCapLinks } from '../../../generated/system-hooks'
import { useCapabilityPresence } from '../../../hooks/use-capability-presence'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import {
  readItemId,
  useDeviceSeriesList,
  useHistoryReads,
} from '../../device-history/use-device-history'
import { counterDayTotal, type EnergyDayWindow } from './energy-day'
import { type LinkedHeatPump, linkedHeatPumpOf } from './energy-model'

/** The energy-system link the heat pump fills (`energy-system.cap.ts`, `customize.links`). */
export const ENERGY_HEAT_PUMP_LINK = { cap: 'energy-system', linkId: 'heat-pump' } as const

/**
 * `pending` until the read answered with a loaded engine; `none` when no link holds (or the read was
 * refused: the system's own branch then stands); `linked` with the source device.
 */
export type HeatPumpLink =
  | { readonly status: 'pending' }
  | { readonly status: 'none' }
  | { readonly status: 'linked'; readonly sourceDeviceId: number }

export function useHeatPumpLink(deviceId: number): HeatPumpLink {
  const read = useCoreBlocksGetCapLinks({ deviceId })
  return useMemo((): HeatPumpLink => {
    // The engine not loaded yet is unknown, not absent (D315): stay pending.
    if (read.status === 'pending' || read.data?.status === 'not-loaded')
      return { status: 'pending' }
    if (read.status === 'error' || read.data === undefined || read.data.status !== 'ok') {
      return { status: 'none' }
    }
    const link = read.data.links.find(
      (row) => row.cap === ENERGY_HEAT_PUMP_LINK.cap && row.linkId === ENERGY_HEAT_PUMP_LINK.linkId,
    )
    return link?.state === 'linked' && link.source.deviceId !== null
      ? { status: 'linked', sourceDeviceId: link.source.deviceId }
      : { status: 'none' }
  }, [read.status, read.data])
}

const PREFIX = 'cap:heat-pump-status.'
const THERMAL = `${PREFIX}energy.thermalKwh`
const ELECTRICAL = `${PREFIX}energy.electricalKwh`

/**
 * The linked device's heat pump over `window`: the live slice and the day's two
 * counters. Null while there is no linked device; each unread part is null.
 */
export function useLinkedHeatPump(
  sourceDeviceId: number | null,
  window: EnergyDayWindow,
): LinkedHeatPump | null {
  const client = useTrpcClient()
  const dev = useDeviceProxy(client, sourceDeviceId)
  const status = useDeviceStateSlice(
    dev?.heatPumpStatus === undefined ? undefined : dev.state.heatPumpStatus,
  )
  const presence = useCapabilityPresence('device-history')
  const { list } = useDeviceSeriesList(sourceDeviceId)
  const items = useMemo<readonly DeviceHistoryQueryManyItem[]>(
    () =>
      sourceDeviceId === null || list.status !== 'ok'
        ? []
        : [THERMAL, ELECTRICAL]
            .filter((key) => list.data.some((info) => info.key === key && info.scope === ''))
            .map((key) => ({ deviceId: sourceDeviceId, key })),
    [sourceDeviceId, list],
  )
  const reads = useHistoryReads(items, window, false, presence === 'present' && items.length > 0)
  return useMemo((): LinkedHeatPump | null => {
    if (sourceDeviceId === null) return null
    const total = (key: string): number | null => {
      if (reads.status !== 'ok') return null
      const entry = reads.data.current.get(readItemId({ deviceId: sourceDeviceId, key }))
      return entry === undefined || !entry.ok ? null : counterDayTotal(entry.result, window.from)
    }
    return linkedHeatPumpOf(status, {
      thermalKwh: total(THERMAL),
      electricalKwh: total(ELECTRICAL),
    })
  }, [sourceDeviceId, status, reads, window.from])
}
