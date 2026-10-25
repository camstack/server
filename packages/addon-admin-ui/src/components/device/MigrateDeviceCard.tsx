/**
 * "Migrate to…" — replacing a camera with different hardware, from the camera's
 * own page.
 *
 * The hub call is `deviceManager.migrateDevice({ sourceId, targetId })`
 * (`packages/system/src/builtins/device-manager/migrate-device.ts`). It moves
 * the NUMBER rather than the work: everything general about a camera — the
 * recording path on disk, the hour ledger, zone ownership and all four
 * ecosystem exports — is keyed on the numeric id, so the replacement inherits
 * the number and the operator keeps their footage, rules and integrations.
 *
 * ## Why this card is not a button with a tick
 *
 * `migrateDevice` returns a REPORT, not a boolean, and the report exists
 * because the camera being replaced is characteristically broken. Two of the
 * eight switches write the camera itself, so on dead hardware they cannot be
 * written at all. The cap therefore answers per switch, and `sourceStillLive`
 * names what stayed running.
 *
 *  - **Empty `sourceStillLive` is the only quiet outcome** and is the only
 *    thing rendered as one.
 *  - **A non-empty one is rendered as what it is**: named functions still live
 *    on hardware the hub could not reach. Not an error — the migration
 *    happened — and emphatically not a success, because the remaining step is
 *    physical.
 *  - **`not-offered` gets its own list.** A switch the old camera never had is
 *    not a switch left running, and merging the two would tell an operator to
 *    go unplug a microphone that never existed.
 *
 * The confirmation is not decoration either: the operation exchanges two device
 * identities and there is no undo, so the dialog says in the operator's words
 * what the number carries with it.
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeftRight, CheckCircle2, CircleSlash, Radio } from 'lucide-react'
import {
  useConfirm,
  useDeviceManagerListAll,
  useDeviceManagerMigrateDevice,
} from '@camstack/ui-library'

import { buildMigrationReport, type MigrationReport } from './migrate-device-report'

export interface MigrateDeviceCardProps {
  /** The camera being replaced — the number the new hardware will inherit. */
  readonly deviceId: number
  /** Its operator-facing name, used verbatim in the confirmation. */
  readonly deviceName: string
}

/** One row of the target picker. */
interface MigrationTarget {
  readonly id: number
  readonly name: string
}

/** The only fields of one `deviceManager.listAll` row this picker reads. */
export interface MigrationTargetFacts {
  readonly id: number
  readonly name: string
  readonly isCamera: boolean
}

/**
 * Plausible targets only: adopted cameras, and never this device.
 *
 * `isCamera` is re-checked even though the query already asks for cameras — the
 * filter is the claim the picker makes, and it should hold whatever the hub
 * returned. Self-exclusion happens HERE as well as in the click handler: the
 * cap throws on `sourceId === targetId`, but an operator should not be able to
 * select an option whose only possible outcome is a refusal.
 */
export function migrationTargets(
  devices: readonly MigrationTargetFacts[],
  deviceId: number,
): readonly MigrationTarget[] {
  return devices
    .filter((device) => device.isCamera && device.id !== deviceId)
    .map((device) => ({ id: device.id, name: device.name }))
    .toSorted((a, b) => a.name.localeCompare(b.name))
}

export function MigrateDeviceCard({ deviceId, deviceName }: MigrateDeviceCardProps) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const [targetId, setTargetId] = useState<number | null>(null)

  const camerasQuery = useDeviceManagerListAll({ isCamera: true, projection: 'slim' })
  const migrate = useDeviceManagerMigrateDevice()

  // D315: "no other camera" is a claim, and a claim needs an ANSWER behind it.
  // `data === undefined` is a query that has not spoken yet, and must never be
  // drawn as an empty fleet.
  const answered = camerasQuery.data !== undefined
  const targets = useMemo(
    () => (camerasQuery.data === undefined ? [] : migrationTargets(camerasQuery.data, deviceId)),
    [camerasQuery.data, deviceId],
  )

  const target = targets.find((candidate) => candidate.id === targetId) ?? null
  const report: MigrationReport | null =
    migrate.data === undefined ? null : buildMigrationReport(migrate.data)
  const failure = migrate.error === null ? null : migrate.error.message

  const runMigration = async (): Promise<void> => {
    // The cap refuses `sourceId === targetId`; refuse it before the call so a
    // stale selection cannot spend a round trip to be told so.
    if (target === null || target.id === deviceId) return
    const confirmed = await confirm({
      title: t('deviceMigrate.confirmTitle', 'Replace “{{source}}” with “{{target}}”?', {
        source: deviceName,
        target: target.name,
      }),
      message: t(
        'deviceMigrate.confirmMessage',
        '“{{target}}” takes over number {{sourceId}}. That number is what every recording, ' +
          'event, rule, zone and home-automation export of “{{source}}” is filed under, so all ' +
          'of it follows the number to the new hardware and keeps working. “{{source}}” is ' +
          'switched off and handed number {{targetId}} in exchange. This swaps two device ' +
          'identities and cannot be undone from here.',
        {
          source: deviceName,
          target: target.name,
          sourceId: deviceId,
          targetId: target.id,
        },
      ),
      confirmLabel: t('deviceMigrate.confirmAction', 'Migrate'),
      variant: 'danger',
    })
    if (!confirmed) return
    migrate.mutate({ sourceId: deviceId, targetId: target.id })
  }

  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-foreground">
            {t('deviceMigrate.title', 'Migrate to…')}
          </h2>
          <p className="mt-0.5 text-[11px] text-foreground-subtle">
            {t(
              'deviceMigrate.subtitle',
              'Replace this camera with other hardware you have already adopted. The new camera ' +
                'inherits number {{deviceId}}, so recordings, rules and integrations follow it.',
              { deviceId },
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <select
            aria-label={t('deviceMigrate.pickerLabel', 'Replacement camera')}
            className="rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground disabled:opacity-50"
            disabled={!answered || targets.length === 0 || migrate.isPending}
            value={targetId === null ? '' : String(targetId)}
            onChange={(event) => {
              const next = event.target.value
              setTargetId(next === '' ? null : Number(next))
            }}
          >
            <option value="">
              {answered
                ? t('deviceMigrate.pickerPlaceholder', 'Select a camera…')
                : t('deviceMigrate.pickerPending', 'Reading the fleet…')}
            </option>
            {targets.map((candidate) => (
              <option key={candidate.id} value={String(candidate.id)}>
                {candidate.name} (#{candidate.id})
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={target === null || migrate.isPending}
            onClick={() => {
              void runMigration()
            }}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface disabled:opacity-50"
          >
            <ArrowLeftRight className="h-3 w-3" />
            {migrate.isPending
              ? t('deviceMigrate.running', 'Migrating…')
              : t('deviceMigrate.action', 'Migrate')}
          </button>
        </div>
      </div>

      {/* An answered query with nothing in it is the only thing allowed to say
          there is nothing to pick. */}
      {answered && targets.length === 0 && (
        <p className="mt-2 text-[11px] text-foreground-subtle">
          {t(
            'deviceMigrate.noTargets',
            'No other camera is adopted, so there is nothing to migrate to.',
          )}
        </p>
      )}

      {failure !== null && (
        <p className="mt-2 text-[11px] text-danger">
          {t('deviceMigrate.failed', 'Migration failed: {{error}}', { error: failure })}
        </p>
      )}

      {report !== null && <MigrationReportBlock report={report} />}
    </div>
  )
}

/**
 * The report. Deliberately has no "done ✓" path of its own — the quiet banner
 * is a statement about the OLD hardware, which is the only claim the result
 * entitles anyone to make.
 */
function MigrationReportBlock({ report }: { report: MigrationReport }) {
  const { t } = useTranslation()
  const quiet = report.verdict === 'quiet'

  return (
    <div className="mt-3 space-y-2 border-t border-border pt-3">
      <p className="text-[11px] text-foreground-subtle">
        {t(
          'deviceMigrate.swapped',
          'The replacement now answers on number {{inheritedId}}; the old camera was handed number {{retiredId}}.',
          { inheritedId: report.inheritedId, retiredId: report.retiredId },
        )}
      </p>

      {quiet ? (
        <div className="flex items-start gap-2 rounded-md border border-success/30 bg-success/5 px-3 py-2">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
          <p className="text-[11px] leading-relaxed text-foreground">
            {t(
              'deviceMigrate.quiet',
              'Every function on the replaced camera was switched off — the old hardware is quiet.',
            )}
          </p>
        </div>
      ) : (
        <div className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2">
          <div className="flex items-start gap-2">
            <Radio className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
            <p className="text-[11px] leading-relaxed text-foreground">
              {t(
                'deviceMigrate.stillLive',
                'The replaced camera could not be reached, so these functions are STILL RUNNING on ' +
                  'the old hardware. Nothing here failed to migrate — but until you unplug it or ' +
                  'reach it physically, it can still produce data.',
              )}
            </p>
          </div>
          <ul className="mt-2 space-y-1 pl-5">
            {report.stillLive.map((line) => (
              <li key={line.switchId} className="text-[11px] text-foreground">
                <span className="font-medium">{line.label}</span>
                {line.detail !== null && (
                  <span className="text-foreground-subtle"> — {line.detail}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Never merged into the list above: "this camera never had it" is not
          "this camera is still doing it". */}
      {report.neverOffered.length > 0 && (
        <div className="rounded-md border border-border px-3 py-2">
          <div className="flex items-start gap-2">
            <CircleSlash className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground-subtle" />
            <p className="text-[11px] leading-relaxed text-foreground-subtle">
              {t(
                'deviceMigrate.neverOffered',
                'The replaced camera never offered these, so there was nothing to switch off. They ' +
                  'are not running.',
              )}
            </p>
          </div>
          <ul className="mt-2 space-y-1 pl-5">
            {report.neverOffered.map((line) => (
              <li key={line.switchId} className="text-[11px] text-foreground-subtle">
                {line.label}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
