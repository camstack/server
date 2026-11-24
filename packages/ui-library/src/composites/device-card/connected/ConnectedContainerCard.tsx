import { useQuery } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useDeviceManagerGetChildren } from '../../../generated/system-hooks'
import {
  type ChildBattery,
  type ContainerCardChild,
  containerCountsOf,
} from '../scenes/container/container-model'
import { ContainerCard } from '../scenes/container/ContainerCard'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { useCardCommon } from './use-card-common'

/** More children than this are counted for reachability only; a battery read each is too many calls. */
const BATTERY_READ_MAX = 50

/** A battery slice's level; a slice that was never written (or carries none) is `none`. */
const levelOf = (slice: Readonly<Record<string, unknown>> | null): number | 'none' => {
  const level = slice?.['level']
  return typeof level === 'number' ? level : 'none'
}

/**
 * One child's battery from the batch read. Everything the read has not
 * answered (pending, failed, past the bound) is `unknown`, never zero or none.
 */
export function childBatteryOf(
  read: ReadonlyMap<number, number | 'none'> | undefined,
  childId: number,
): ChildBattery {
  return read?.get(childId) ?? 'unknown'
}

/**
 * A container: the count of its child devices, online / offline / low battery.
 * Reachability is the child's own `online`; the level is read from its `battery`
 * slice, and a level that could not be read stays unknown, never zero.
 */
export function ConnectedContainerCard({
  deviceId,
  canActuate = true,
  orientation,
  showName = true,
}: ConnectedCardProps): ReactElement {
  const client = useTrpcClient()
  const card = useCardCommon({ deviceId, canActuate })
  const children = useDeviceManagerGetChildren({ parentDeviceId: deviceId })
  const ids = (children.data ?? []).slice(0, BATTERY_READ_MAX).map((c) => c.id)
  const batteries = useQuery({
    queryKey: ['container-card-batteries', deviceId, ids],
    enabled: ids.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<ReadonlyMap<number, number | 'none'>> => {
      const settled = await Promise.allSettled(
        ids.map((id) => client.deviceState.getCapSlice.query({ deviceId: id, capName: 'battery' })),
      )
      const levels = new Map<number, number | 'none'>()
      settled.forEach((r, i) => {
        const id = ids[i]
        if (id !== undefined && r.status === 'fulfilled') levels.set(id, levelOf(r.value))
      })
      return levels
    },
  })
  const rows: readonly ContainerCardChild[] | null =
    children.data === undefined
      ? null
      : children.data.map((c) => ({
          online: c.online,
          battery: childBatteryOf(batteries.data, c.id),
        }))
  return (
    <ContainerCard
      orientation={orientation}
      showName={showName}
      model={{
        common: card.common,
        counts: rows === null ? null : containerCountsOf(rows),
        failed: children.status === 'error',
      }}
      actions={card.actions}
    />
  )
}
