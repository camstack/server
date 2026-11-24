import { useQuery } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useDeviceManagerGetChildren } from '../../../generated/system-hooks'
import { type ContainerCardChild, containerCountsOf } from '../scenes/container/container-model'
import { ContainerCard } from '../scenes/container/ContainerCard'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { useCardCommon } from './use-card-common'

/** More children than this are counted for reachability only; a battery read each is too many calls. */
const BATTERY_READ_MAX = 50

const levelOf = (slice: Readonly<Record<string, unknown>> | null): number | null => {
  const level = slice?.['level']
  return typeof level === 'number' ? level : null
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
    queryFn: async (): Promise<ReadonlyMap<number, number>> => {
      const settled = await Promise.allSettled(
        ids.map((id) => client.deviceState.getCapSlice.query({ deviceId: id, capName: 'battery' })),
      )
      const levels = new Map<number, number>()
      settled.forEach((r, i) => {
        const id = ids[i]
        const level = r.status === 'fulfilled' ? levelOf(r.value) : null
        if (id !== undefined && level !== null) levels.set(id, level)
      })
      return levels
    },
  })
  const rows: readonly ContainerCardChild[] | null =
    children.data === undefined
      ? null
      : children.data.map((c) => ({ online: c.online, battery: batteries.data?.get(c.id) ?? null }))
  return (
    <ContainerCard
      orientation={orientation}
      showName={showName}
      model={{ common: card.common, counts: rows === null ? null : containerCountsOf(rows) }}
      actions={card.actions}
    />
  )
}
