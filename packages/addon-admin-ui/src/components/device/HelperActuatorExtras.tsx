/**
 * Switch and light groups on the device page (D944). A light lists the
 * controls every member binds, and both list the last command per member.
 * Bindings that have not answered stay pending — they are not "no shared
 * controls".
 */
import type { GroupTemplate, HelperMember } from '@camstack/types'
import { ErrorBox, useDeviceManagerGetBindings } from '@camstack/ui-library'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  commandResultsFromSnapshot,
  type CommandResultsView,
  type MemberCapRead,
  type SharedCapsView,
  type SnapshotRead,
  sharedCapsView,
} from '../composition-editor/helper-form-model'

export interface ActuatorMemberRow {
  readonly id: number
  readonly name: string
  readonly features: readonly string[]
}

export interface ActuatorFleetRow {
  readonly id: number
  readonly name: string
  readonly addonId: string
  readonly stableId: string
  readonly features: readonly string[]
}

export interface HelperActuatorExtrasProps {
  readonly template: GroupTemplate
  readonly members: readonly HelperMember[]
  readonly fleet: readonly ActuatorFleetRow[]
  readonly fleetKind: 'pending' | 'error' | 'answered'
  readonly snapshot: SnapshotRead
  readonly nameOf: (deviceId: number) => string
}

export function HelperActuatorExtras({
  template,
  members,
  fleet,
  fleetKind,
  snapshot,
  nameOf,
}: HelperActuatorExtrasProps): ReactNode {
  const { t } = useTranslation()
  const [caps, setCaps] = useState<ReadonlyMap<string, MemberCapRead>>(() => new Map())
  const report = useCallback((key: string, read: MemberCapRead): void => {
    setCaps((current) => {
      const previous = current.get(key)
      if (sameRead(previous, read)) return current
      const next = new Map(current)
      next.set(key, read)
      return next
    })
  }, [])
  if (template.family !== 'actuator') return null
  const commands = commandResultsFromSnapshot(snapshot)
  const shared =
    template.id === 'light'
      ? sharedCapsView(members.map((member) => caps.get(memberKey(member)) ?? { kind: 'pending' }))
      : null
  return (
    <>
      {template.id === 'light' &&
        members.map((member) => (
          <MemberCapProbe
            key={memberKey(member)}
            member={member}
            row={rowFor(fleet, member)}
            fleetKind={fleetKind}
            onRead={report}
          />
        ))}
      {shared !== null && <SharedCaps view={shared} />}
      <div data-testid="helper-commands">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-foreground-subtle">
          {t('helper.commandTitle')}
        </h3>
        {commands.kind === 'pending' && (
          <p role="status" className="mt-1 text-xs text-foreground-subtle">
            {t('helper.reportingPending')}
          </p>
        )}
        {commands.kind === 'unavailable' && (
          <ErrorBox title={t('helper.outputUnavailable')} message={commands.message} />
        )}
        {commands.kind === 'none' && (
          <p className="mt-1 text-xs text-foreground-muted">{t('helper.commandNone')}</p>
        )}
        {commands.kind === 'rows' && <CommandList view={commands} nameOf={nameOf} />}
      </div>
    </>
  )
}

function SharedCaps({ view }: { readonly view: SharedCapsView }): ReactNode {
  const { t } = useTranslation()
  return (
    <div data-testid="helper-shared-caps">
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-foreground-subtle">
        {t('helper.sharedCaps')}
      </h3>
      {view.kind === 'pending' && (
        <p role="status" className="mt-1 text-xs text-foreground-subtle">
          {t('helper.sharedPending')}
        </p>
      )}
      {view.kind === 'unavailable' && (
        <p role="status" className="mt-1 text-xs text-foreground-subtle">
          {t('helper.sharedUnavailable')}
        </p>
      )}
      {view.kind === 'ready' && view.caps.length <= 1 && (
        <p className="mt-1 text-xs text-foreground-muted">{t('helper.sharedNone')}</p>
      )}
      {view.kind === 'ready' && view.caps.length > 1 && (
        <ul className="mt-1 flex flex-col gap-0.5 text-xs text-foreground">
          {view.caps
            .filter((cap) => cap !== 'switch')
            .map((cap) => (
              <li key={cap}>{t(`helper.cap.${cap}`)}</li>
            ))}
          {view.modes.map((mode) => (
            <li key={mode}>{t(`helper.mode.${mode}`)}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function CommandList({
  view,
  nameOf,
}: {
  readonly view: Extract<CommandResultsView, { readonly kind: 'rows' }>
  readonly nameOf: (deviceId: number) => string
}): ReactNode {
  const { t } = useTranslation()
  return (
    <ul
      className="mt-1 flex flex-col gap-0.5 text-xs text-foreground"
      data-testid="helper-command-rows"
    >
      {view.rows.map((row) => (
        <li key={`${row.deviceId}:${row.cap}:${row.at}`}>
          {nameOf(row.deviceId)} — {t(`helper.cap.${row.cap}`)} —{' '}
          {row.ok ? t('helper.commandOk') : t('helper.commandFailed')}
          {row.error === null ? '' : ` — ${row.error}`}
        </li>
      ))}
    </ul>
  )
}

function MemberCapProbe({
  member,
  row,
  fleetKind,
  onRead,
}: {
  readonly member: HelperMember
  readonly row: ActuatorMemberRow | null
  readonly fleetKind: 'pending' | 'error' | 'answered'
  readonly onRead: (key: string, read: MemberCapRead) => void
}): ReactNode {
  const key = memberKey(member)
  const bindings = useDeviceManagerGetBindings(
    { deviceId: row?.id ?? 0 },
    { enabled: fleetKind === 'answered' && row !== null },
  )
  useEffect(() => {
    if (fleetKind !== 'answered') {
      onRead(key, { kind: 'pending' })
      return
    }
    if (row === null) {
      onRead(key, { kind: 'ready', caps: [], features: [] })
      return
    }
    if (bindings.status === 'pending') {
      onRead(key, { kind: 'pending' })
      return
    }
    if (bindings.status === 'error') {
      onRead(key, { kind: 'error' })
      return
    }
    onRead(key, {
      kind: 'ready',
      caps: bindings.data.entries.map((entry) => entry.capName),
      features: [...row.features],
    })
  }, [bindings.data, bindings.status, fleetKind, key, onRead, row])
  return null
}

function rowFor(
  fleet: readonly ActuatorFleetRow[],
  member: HelperMember,
): ActuatorMemberRow | null {
  const found = fleet.find(
    (item) => item.addonId === member.source.addonId && item.stableId === member.source.stableId,
  )
  if (found === undefined) return null
  return { id: found.id, name: found.name, features: found.features }
}

function memberKey(member: HelperMember): string {
  return `${member.source.addonId}/${member.source.stableId}`
}

function sameRead(previous: MemberCapRead | undefined, read: MemberCapRead): boolean {
  if (previous === undefined || previous.kind !== read.kind) return false
  if (previous.kind !== 'ready' || read.kind !== 'ready') return true
  return (
    previous.caps.join('\0') === read.caps.join('\0') &&
    previous.features.join('\0') === read.features.join('\0')
  )
}
