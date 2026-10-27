/**
 * Actuator groups on the device page (D944): what the group offers — only the
 * methods every member can take — and the last command per member. A lock
 * group also carries the two buttons, and unlocking it asks first, every time.
 * Bindings that have not answered stay pending — they are not "nothing shared".
 */
import type { GroupTemplate, HelperMember } from '@camstack/types'
import {
  Button,
  ConfirmActionButton,
  ErrorBox,
  useDeviceManagerGetBindings,
  useLockControlLock,
  useLockControlUnlock,
} from '@camstack/ui-library'
import { Lock, LockOpen } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  commandResultsFromSnapshot,
  type CommandResultsView,
  type MemberCapRead,
  type SharedMethodsView,
  type SnapshotRead,
  sharedMethodsView,
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
  /** The group's own device: the lock buttons command it. */
  readonly deviceId: number
  readonly template: GroupTemplate
  readonly members: readonly HelperMember[]
  readonly fleet: readonly ActuatorFleetRow[]
  readonly fleetKind: 'pending' | 'error' | 'answered'
  readonly snapshot: SnapshotRead
  readonly nameOf: (deviceId: number) => string
}

export function HelperActuatorExtras({
  deviceId,
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
  const offersMore = template.id !== 'switch'
  const shared = offersMore
    ? sharedMethodsView(
        template.id,
        members.map((member) => caps.get(memberKey(member)) ?? { kind: 'pending' }),
      )
    : null
  return (
    <>
      {offersMore &&
        members.map((member) => (
          <MemberCapProbe
            key={memberKey(member)}
            member={member}
            row={rowFor(fleet, member)}
            fleetKind={fleetKind}
            onRead={report}
          />
        ))}
      {shared !== null && <SharedMethods view={shared} />}
      {template.id === 'lock' && <LockButtons deviceId={deviceId} />}
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

function SharedMethods({ view }: { readonly view: SharedMethodsView }): ReactNode {
  const { t } = useTranslation()
  const listed =
    view.kind === 'ready' ? view.methods.filter((name) => name !== 'switch.setState') : []
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
      {view.kind === 'ready' && listed.length === 0 && (
        <p className="mt-1 text-xs text-foreground-muted">{t('helper.sharedNone')}</p>
      )}
      {view.kind === 'ready' && listed.length > 0 && (
        <ul className="mt-1 flex flex-col gap-0.5 text-xs text-foreground">
          {listed.map((name) => (
            <li key={name}>{t(`helper.method.${name}`)}</li>
          ))}
          {view.modes
            .filter((mode) => mode.startsWith('light-color'))
            .map((mode) => (
              <li key={mode}>{t(`helper.mode.${mode}`)}</li>
            ))}
        </ul>
      )}
    </div>
  )
}

/** Locking is one tap. Unlocking asks first, and the group refuses it without the confirmation. */
function LockButtons({ deviceId }: { readonly deviceId: number }): ReactNode {
  const { t } = useTranslation()
  const lock = useLockControlLock()
  const unlock = useLockControlUnlock()
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="flex flex-col gap-2" data-testid="helper-lock-controls">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          data-testid="helper-lock-all"
          disabled={lock.isPending}
          onClick={() => {
            setError(null)
            lock
              .mutateAsync({ deviceId })
              .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
          }}
        >
          <Lock className="h-4 w-4" aria-hidden />
          {t('helper.lockAll')}
        </Button>
        <ConfirmActionButton
          label={t('helper.unlockAll')}
          icon={LockOpen}
          title={t('helper.unlockTitle')}
          description={t('helper.unlockBody')}
          confirmLabel={t('helper.unlockConfirm')}
          triggerVariant="outline"
          action={() => unlock.mutateAsync({ deviceId, confirm: true })}
        />
      </div>
      {error !== null && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
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
          {nameOf(row.deviceId)} — {t(`helper.method.${row.cap}.${row.method}`)} —{' '}
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
