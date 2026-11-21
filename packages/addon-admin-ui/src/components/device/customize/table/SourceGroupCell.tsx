/**
 * The "Source device" row of a cap group the spec declares: ONE device picker
 * that fills every reading of the group the device provides. The per-reading
 * rows below stay editable and override it; storage is theirs, not this row's.
 */
import type { CustomizeSourceGroup, DeviceInfo } from '@camstack/types'
import {
  Badge,
  DeviceValuePicker,
  useDeviceManagerGetWireableFields,
  useDeviceStateGetSnapshot,
} from '@camstack/ui-library'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useCandidateDevices } from '../assignments/use-source-candidates'
import { currentComposition } from '../customization-read'
import { liveWireableCatalog } from '../source-picker-model'
import { scalarFieldOffers } from '../scalar/scalar-fit'
import type { CustomizationHandle } from '../use-customization'
import { vocabularyFieldLabel } from '../vocabulary-field-label'
import { fillSourceGroup, type GroupFillResult, groupSourceState } from './source-group'

export interface SourceGroupProps {
  readonly device: DeviceInfo
  readonly handle: CustomizationHandle
  readonly cap: string
  readonly group: CustomizeSourceGroup
}

/** Where a pick stands: reading the device's fields, or done with what was filled and what was not. */
type PickOutcome =
  | { readonly kind: 'idle' }
  | { readonly kind: 'filling'; readonly deviceId: number }
  | { readonly kind: 'done'; readonly result: GroupFillResult }
  | { readonly kind: 'refused'; readonly reason: string }

export function SourceGroupCell(props: SourceGroupProps): ReactNode {
  const { t } = useTranslation()
  const [outcome, setOutcome] = useState<PickOutcome>({ kind: 'idle' })
  const candidates = useCandidateDevices(true)
  const state = groupSourceState({
    cap: props.cap,
    group: props.group,
    host: props.handle.target,
    current: currentComposition(props.handle.state),
  })
  const sourceId =
    state.kind === 'single' && candidates.kind === 'known'
      ? (candidates.value.find(
          (row) => row.addonId === state.source.addonId && row.stableId === state.source.stableId,
        )?.id ?? null)
      : null
  const shownId = outcome.kind === 'filling' ? outcome.deviceId : sourceId
  const answered = props.handle.state.kind === 'none' || props.handle.state.kind === 'present'
  return (
    <span className="flex flex-col gap-1" data-testid={`source-group-${props.cap}`}>
      {state.kind === 'mixed' && outcome.kind !== 'filling' && (
        <Badge data-testid={`source-group-mixed-${props.cap}`}>
          {t('customize.table.group.mixed')}
        </Badge>
      )}
      <DeviceValuePicker
        pick="device"
        noun="device"
        requires={{ caps: [props.cap] }}
        contextDeviceId={props.device.id}
        recentKey={`customize-group-${props.cap}`}
        testId={`source-group-picker-${props.cap}`}
        disabled={!answered || props.handle.saving}
        clearable={false}
        value={shownId === null ? null : { deviceId: shownId }}
        onChange={(picked) => {
          if (picked !== null) setOutcome({ kind: 'filling', deviceId: picked.deviceId })
        }}
      />
      {outcome.kind === 'filling' && (
        <GroupFillRunner
          key={outcome.deviceId}
          {...props}
          deviceId={outcome.deviceId}
          onDone={setOutcome}
        />
      )}
      <GroupOutcomeText cap={props.cap} outcome={outcome} />
      {outcome.kind === 'idle' && (
        <span className="text-[11px] text-foreground-muted">{t('customize.table.group.hint')}</span>
      )}
    </span>
  )
}

interface GroupFillRunnerProps extends SourceGroupProps {
  readonly deviceId: number
  readonly onDone: (outcome: PickOutcome) => void
}

/** Reads the picked device's fields, then fills the group exactly once. Renders nothing. */
function GroupFillRunner(props: GroupFillRunnerProps): null {
  const candidates = useCandidateDevices(true)
  const wireable = useDeviceManagerGetWireableFields({ deviceId: props.deviceId })
  const snapshot = useDeviceStateGetSnapshot({ deviceId: props.deviceId })
  const ran = useRef(false)
  const source =
    candidates.kind === 'known'
      ? (candidates.value.find((row) => row.id === props.deviceId) ?? null)
      : null
  const ready = wireable.status === 'success' && snapshot.status !== 'pending' && source !== null
  const { handle, cap, group, onDone } = props
  useEffect(() => {
    if (ran.current) return
    if (wireable.status === 'error') {
      ran.current = true
      onDone({ kind: 'refused', reason: wireable.error?.message ?? '' })
      return
    }
    if (!ready || wireable.data === undefined || source === null) return
    ran.current = true
    const catalog = liveWireableCatalog(
      wireable.data,
      snapshot.status === 'success' ? snapshot.data : null,
    )
    const result = fillSourceGroup({
      cap,
      group,
      host: handle.target,
      source: { addonId: source.addonId, stableId: source.stableId },
      offers: scalarFieldOffers(catalog, snapshot.status === 'success' ? snapshot.data : null),
      current: currentComposition(handle.state),
    })
    if (result.filled.length === 0 || result.composition === null) {
      onDone({ kind: 'done', result })
      return
    }
    void handle.save(result.composition).then((saved) => {
      onDone(
        saved.kind === 'refused'
          ? { kind: 'refused', reason: saved.reason }
          : { kind: 'done', result },
      )
    })
  }, [
    ready,
    wireable.status,
    wireable.data,
    wireable.error,
    snapshot.status,
    snapshot.data,
    source,
    cap,
    group,
    handle,
    onDone,
  ])
  return null
}

function GroupOutcomeText({
  cap,
  outcome,
}: {
  readonly cap: string
  readonly outcome: PickOutcome
}): ReactNode {
  const { t, i18n } = useTranslation()
  if (outcome.kind === 'idle' || outcome.kind === 'filling') return null
  if (outcome.kind === 'refused') {
    return (
      <span role="alert" className="text-[11px] text-danger break-words">
        {outcome.reason}
      </span>
    )
  }
  const names = (ids: readonly string[]): string =>
    ids.map((id) => vocabularyFieldLabel(cap, id, i18n.language)).join(', ')
  const { filled, skipped } = outcome.result
  return (
    <span className="flex flex-col gap-0.5 text-[11px] text-foreground-muted" role="status">
      {filled.length === 0 ? (
        <span>{t('customize.table.group.nothing')}</span>
      ) : (
        <span>{t('customize.table.group.filled', { names: names(filled) })}</span>
      )}
      {filled.length > 0 && skipped.length > 0 && (
        <span>{t('customize.table.group.skipped', { names: names(skipped) })}</span>
      )}
    </span>
  )
}
