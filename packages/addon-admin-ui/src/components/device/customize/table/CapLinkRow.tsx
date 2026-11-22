/**
 * The "Source device" row of a whole-capability link the cap declares (D1076):
 * one picker, one stored `capLink` feature. The per-reading rows below it are
 * not touched; a link that would also take a field one of them stores is
 * refused by the server, and the reason is shown here.
 */
import type { DeviceInfo } from '@camstack/types'
import { CapLinkCell, useCoreBlocksGetCapLinks } from '@camstack/ui-library'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useCandidateDevices } from '../assignments/use-source-candidates'
import { currentComposition } from '../customization-read'
import type { CustomizationHandle } from '../use-customization'
import {
  capLinkCellState,
  type OfferedCapLink,
  storedCapLink,
  withCapLink,
  withoutCapLink,
} from './cap-link-edit'

export interface CapLinkRowProps {
  readonly device: Pick<DeviceInfo, 'id'>
  readonly handle: CustomizationHandle
  readonly offered: OfferedCapLink
}

export function CapLinkRow(props: CapLinkRowProps): ReactNode {
  const { t } = useTranslation()
  const [error, setError] = useState<string | null>(null)
  const candidates = useCandidateDevices(true)
  const read = useCoreBlocksGetCapLinks({ deviceId: props.device.id })
  const current = currentComposition(props.handle.state)
  const stored = storedCapLink(current, props.offered.cap, props.offered.link.id)
  const views = read.data?.status === 'ok' ? read.data.links : null
  const sourceDeviceId =
    stored !== null && candidates.kind === 'known'
      ? (candidates.value.find(
          (row) => row.addonId === stored.source.addonId && row.stableId === stored.source.stableId,
        )?.id ?? null)
      : null
  const answered = props.handle.state.kind === 'none' || props.handle.state.kind === 'present'
  const change = async (pickedId: number | null): Promise<void> => {
    setError(null)
    if (pickedId === null) {
      if (current === null) return
      const outcome = await props.handle.save(withoutCapLink(current, props.offered))
      if (outcome.kind === 'refused') setError(outcome.reason)
      return
    }
    if (candidates.kind !== 'known') return
    const picked = candidates.value.find((row) => row.id === pickedId)
    if (picked === undefined) return
    const outcome = await props.handle.save(
      withCapLink(current, props.handle.target, props.offered, {
        addonId: picked.addonId,
        stableId: picked.stableId,
      }),
    )
    if (outcome.kind === 'refused') setError(outcome.reason)
  }
  return (
    <CapLinkCell
      deviceId={props.device.id}
      sourceCap={props.offered.link.sourceCap}
      sourceDeviceId={sourceDeviceId}
      state={capLinkCellState(stored, views, props.offered)}
      disabled={!answered || candidates.kind !== 'known' || props.handle.saving}
      error={error}
      hint={
        props.offered.link.mode === 'reference'
          ? t('customize.table.capLink.referenceHint')
          : t('customize.table.capLink.projectHint')
      }
      testId={`cap-link-${props.offered.cap}-${props.offered.link.id}`}
      onChange={(id) => void change(id)}
    />
  )
}
