/**
 * A helper's device page: the output reading, how many members reported,
 * and the names of the ones left out (D944). Counts come from `group-status`.
 * A member whose read has not answered is not listed as excluded.
 */
import {
  COMPOSED_DEVICE_STABLE_ID_PREFIX,
  coreBlockComposition,
  groupTemplate,
  type HelperMember,
} from '@camstack/types'
import {
  ErrorBox,
  SECTION_BODY,
  SectionCard,
  StatCard,
  useCoreBlocksGetComposition,
  useDeviceManagerListAll,
  useDeviceStateGetSnapshot,
} from '@camstack/ui-library'
import { Boxes } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { HelperActuatorExtras } from './HelperActuatorExtras'
import {
  fieldStateOf,
  groupStatusFromSnapshot,
  isHelperComposition,
  type MemberLive,
  memberPresence,
  namedExcluded,
  outputReading,
  type SnapshotRead,
  snapshotCaps,
} from '../composition-editor/helper-form-model'

export interface HelperGroupStatusProps {
  readonly deviceId: number
  readonly stableId: string
}

interface FleetRow {
  readonly id: number
  readonly name: string
  readonly online: boolean
  readonly addonId: string
  readonly stableId: string
  readonly features: readonly string[]
}

export function HelperGroupStatus({ deviceId, stableId }: HelperGroupStatusProps): ReactNode {
  const { t } = useTranslation()
  const blockId = stableId.startsWith(COMPOSED_DEVICE_STABLE_ID_PREFIX)
    ? stableId.slice(COMPOSED_DEVICE_STABLE_ID_PREFIX.length)
    : null
  const read = useCoreBlocksGetComposition(
    { blockId: blockId ?? '' },
    { enabled: blockId !== null },
  )
  const snapshot = useDeviceStateGetSnapshot({ deviceId }, { enabled: blockId !== null })
  const fleet = useDeviceManagerListAll({ projection: 'slim' }, { enabled: blockId !== null })
  const [lives, setLives] = useState<ReadonlyMap<string, MemberLive>>(() => new Map())
  const report = useCallback((key: string, live: MemberLive) => {
    setLives((current) => {
      const previous = current.get(key)
      if (previous?.name === live.name && previous.presence === live.presence) return current
      const next = new Map(current)
      next.set(key, live)
      return next
    })
  }, [])

  if (blockId === null) return null
  if (read.status === 'pending') {
    return (
      <p role="status" className="text-xs text-foreground-subtle">
        {t('helper.checking')}
      </p>
    )
  }
  if (read.status === 'error') {
    return <ErrorBox title={t('helper.outputUnavailable')} message={read.error.message} />
  }
  if (read.data.state !== 'loaded' || read.data.view === null) return null
  const composition = coreBlockComposition(read.data.view.block)
  if (composition === null || !isHelperComposition(composition)) return null
  const template = groupTemplate(composition.helper.templateId)
  if (template === null) return null

  const snapshotRead = snapshotReadOf(snapshot.status, snapshot.data, snapshot.error?.message)
  const reading = outputReading(snapshotRead, template)
  const status = groupStatusFromSnapshot(snapshotRead)
  const rows = fleet.status === 'success' ? fleet.data.map(fleetRow) : []
  const fleetKind = fleetKindOf(fleet.status)
  const excluded = namedExcluded(
    composition.helper.members.map(
      (member) =>
        lives.get(memberKey(member)) ?? { name: member.source.stableId, presence: 'unknown' },
    ),
  )
  const value =
    reading.kind === 'number'
      ? reading.unit === undefined
        ? String(reading.value)
        : `${reading.value} ${reading.unit}`
      : reading.kind === 'boolean'
        ? reading.value
          ? t('helper.on')
          : t('helper.off')
        : reading.kind === 'empty'
          ? t('helper.noReading')
          : null

  return (
    <SectionCard
      headingId="helper-group-status"
      title={t('helper.statusTitle')}
      icon={Boxes}
      testId="helper-group-status"
    >
      <div className={`${SECTION_BODY} flex flex-col gap-3`}>
        {composition.helper.members.map((member) => (
          <MemberProbe
            key={memberKey(member)}
            member={member}
            row={
              rows.find(
                (item) =>
                  item.addonId === member.source.addonId &&
                  item.stableId === member.source.stableId,
              ) ?? null
            }
            fleetKind={fleetKind}
            onLive={report}
          />
        ))}
        {reading.kind === 'pending' && (
          <p role="status" className="text-xs text-foreground-subtle">
            {t('helper.outputPending')}
          </p>
        )}
        {reading.kind === 'unavailable' && (
          <ErrorBox title={t('helper.outputUnavailable')} message={reading.message} />
        )}
        {value !== null && <StatCard value={value} label={t(`helper.template.${template.id}`)} />}
        {status.kind === 'pending' && (
          <p role="status" className="text-xs text-foreground-subtle">
            {t('helper.reportingPending')}
          </p>
        )}
        {status.kind === 'unavailable' && (
          <ErrorBox title={t('helper.outputUnavailable')} message={status.message} />
        )}
        {status.kind === 'absent' && (
          <p role="status" className="text-xs text-foreground-subtle">
            {t('helper.reportingAbsent')}
          </p>
        )}
        {status.kind === 'ready' && (
          <p className="text-sm text-foreground" data-testid="helper-reporting">
            {t('helper.reporting', { included: status.included, total: status.total })}
          </p>
        )}
        {status.kind === 'ready' && status.excluded > 0 && (
          <div>
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-foreground-subtle">
              {t('helper.excluded')}
            </h3>
            {excluded.kind === 'pending' ? (
              <p role="status" className="mt-1 text-xs text-foreground-subtle">
                {t('helper.excludedPending')}
              </p>
            ) : excluded.names.length === 0 ? (
              <p className="mt-1 text-xs text-foreground-muted">{t('helper.excludedUnnamed')}</p>
            ) : (
              <ul
                className="mt-1 flex flex-col gap-0.5 text-xs text-foreground"
                data-testid="helper-excluded"
              >
                {excluded.names.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        <HelperActuatorExtras
          template={template}
          members={composition.helper.members}
          fleet={rows.map((row) => ({
            id: row.id,
            name: row.name,
            addonId: row.addonId,
            stableId: row.stableId,
            features: row.features,
          }))}
          fleetKind={fleetKind}
          snapshot={snapshotRead}
          nameOf={(id) => rows.find((row) => row.id === id)?.name ?? String(id)}
        />
      </div>
    </SectionCard>
  )
}

function MemberProbe({
  member,
  row,
  fleetKind,
  onLive,
}: {
  readonly member: HelperMember
  readonly row: FleetRow | null
  readonly fleetKind: 'pending' | 'error' | 'answered'
  readonly onLive: (key: string, live: MemberLive) => void
}): ReactNode {
  const online = row?.online === true
  const snapshot = useDeviceStateGetSnapshot(
    { deviceId: row?.id ?? 0 },
    { enabled: fleetKind === 'answered' && row !== null && online },
  )
  const field = fieldStateOf(
    snapshot.status,
    snapshot.status === 'success' ? snapshotCaps(snapshot.data) : undefined,
    member.cap,
    member.fieldPath,
  )
  const presence = memberPresence({
    fleet: fleetKind,
    deviceOnline: fleetKind === 'answered' ? (row === null ? null : row.online) : true,
    field,
  })
  const name = row?.name ?? member.source.stableId
  const key = memberKey(member)
  useEffect(() => {
    onLive(key, { name, presence })
  }, [key, name, onLive, presence])
  return null
}

function memberKey(member: HelperMember): string {
  return `${member.source.addonId}/${member.source.stableId}/${member.cap}.${member.fieldPath}`
}

function snapshotReadOf(
  status: 'pending' | 'error' | 'success',
  data: unknown,
  message: string | undefined,
): SnapshotRead {
  if (status === 'pending') return { kind: 'pending' }
  if (status === 'error') return { kind: 'error', message: message ?? '' }
  return { kind: 'answered', caps: snapshotCaps(data) }
}

function fleetRow(item: {
  readonly id: number
  readonly name: string
  readonly online: boolean
  readonly addonId: string
  readonly stableId: string
  readonly features?: readonly string[]
}): FleetRow {
  return {
    id: item.id,
    name: item.name,
    online: item.online,
    addonId: item.addonId,
    stableId: item.stableId,
    features: item.features ?? [],
  }
}

function fleetKindOf(status: 'pending' | 'error' | 'success'): 'pending' | 'error' | 'answered' {
  if (status === 'pending') return 'pending'
  if (status === 'error') return 'error'
  return 'answered'
}
