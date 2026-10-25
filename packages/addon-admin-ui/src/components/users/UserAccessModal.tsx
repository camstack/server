/**
 * <UserAccessModal> — a person is an ADMIN or a VIEWER (D921).
 *
 *   - Admin: everything, on every device. Nothing else to choose.
 *   - Viewer: one device list, in "All devices except…" or "Only these
 *     devices…", plus the named features on top of the viewer baseline.
 *
 * The picker is the shared {@link DevicePicker}. It lists parents; a camera's
 * children follow it. Every decision about what Save writes lives in
 * `user-role-model.ts`.
 */
import { useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { VIEWER_FEATURES, type SafeUser } from '@camstack/types'
import {
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorBox,
  SegmentedChoice,
  type DeviceListState,
  type PickerItem,
  useDeviceManagerListAll,
} from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'

import { DevicePicker } from '../../pages/system/DevicePicker'
import { RolePreview } from './RolePreview'
import {
  draftFromUser,
  invalidReasonOf,
  saveRequestOf,
  withFeature,
  withMode,
  withPickedIds,
  withRole,
  type RoleDraft,
  type RoleSaveRequest,
  type ViewerDeviceMode,
} from './user-role-model'

interface UserAccessModalProps {
  readonly user: SafeUser
  /** The signed-in operator is editing themself: demoting is refused here. */
  readonly isSelf: boolean
  readonly onClose: () => void
  readonly onSubmit: (request: RoleSaveRequest) => void
  readonly submitting: boolean
  /** The last save's failure, in words; `null` when there is none. */
  readonly error: string | null
}

const SECTION_HEADING = 'text-[11px] font-semibold uppercase tracking-wide text-foreground-subtle'

/** A slim fleet row, the fields the picker reads. */
interface FleetRow {
  readonly id: number
  readonly name: string
  readonly type: string | number
  readonly location: string | null
  readonly parentDeviceId: number | null
}

function listStateOf(failed: boolean, rows: readonly FleetRow[] | undefined): DeviceListState {
  if (failed) return 'failed'
  return rows === undefined ? 'pending' : 'answered'
}

/** Parents only. A child follows its camera, so listing it beside the parent says nothing. */
function parentItems(rows: readonly FleetRow[]): readonly PickerItem<number>[] {
  const items: PickerItem<number>[] = []
  for (const row of rows) {
    if (row.parentDeviceId !== null) continue
    items.push({
      id: row.id,
      name: row.name,
      type: String(row.type),
      ...(row.location !== null ? { location: row.location } : {}),
    })
  }
  return items
}

export function UserAccessModal({
  user,
  isSelf,
  onClose,
  onSubmit,
  submitting,
  error,
}: UserAccessModalProps): React.ReactElement {
  const { t } = useTranslation()
  const initial = useMemo(() => draftFromUser(user), [user])
  const [draft, setDraft] = useState<RoleDraft>(initial)
  const devicesQuery = useDeviceManagerListAll({ projection: 'slim' })
  const rows: readonly FleetRow[] | undefined = devicesQuery.data
  const listState = listStateOf(devicesQuery.isError, rows)
  const parents = useMemo(() => parentItems(rows ?? []), [rows])
  const fleet = useMemo(
    () => ({
      state: listState,
      devices:
        listState === 'answered'
          ? (rows ?? []).map((row) => ({ id: row.id, name: row.name }))
          : undefined,
    }),
    [listState, rows],
  )

  const reason = invalidReasonOf(draft)
  const request = saveRequestOf(draft)
  const reasonText =
    reason === 'no-allowed-device' ? t('users.userAccessModal.pickAllowedDevice') : null

  const pickRole = (role: 'admin' | 'viewer'): void => {
    setDraft(withRole(draft, role))
  }

  const modeOptions: readonly { readonly value: ViewerDeviceMode; readonly label: string }[] = [
    { value: 'except', label: t('users.userAccessModal.modeExcept') },
    { value: 'only', label: t('users.userAccessModal.modeOnly') },
  ]

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent width="lg" placement="sheet-on-mobile" scroll="body" className="md:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('users.userAccessModal.title', { name: user.username })}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {draft.unconfigured && draft.role === 'viewer' && (
            <ErrorBox
              variant="warning"
              title={t('users.userAccessModal.noAccessYet')}
              message={t('users.userAccessModal.noAccessYetDetail', { name: user.username })}
            />
          )}

          <section className="space-y-2">
            <h3 className={SECTION_HEADING}>{t('users.userAccessModal.role')}</h3>
            <div
              role="radiogroup"
              aria-label={t('users.userAccessModal.role')}
              className="grid gap-1.5 sm:grid-cols-2"
            >
              <RoleOption
                name="admin"
                checked={draft.role === 'admin'}
                label={t('users.userAccessModal.admin')}
                description={t('users.userAccessModal.adminDescription')}
                onPick={() => pickRole('admin')}
              />
              <RoleOption
                name="viewer"
                checked={draft.role === 'viewer'}
                disabled={isSelf}
                label={t('users.userAccessModal.viewer')}
                description={
                  isSelf
                    ? t('users.userAccessModal.cannotDemoteSelf')
                    : t('users.userAccessModal.viewerDescription')
                }
                onPick={() => pickRole('viewer')}
              />
            </div>
          </section>

          {draft.role === 'viewer' && (
            <>
              <section className="space-y-3">
                <h3 className={SECTION_HEADING}>{t('users.userAccessModal.devices')}</h3>
                <SegmentedChoice<ViewerDeviceMode>
                  label={t('users.userAccessModal.whichDevices')}
                  value={draft.mode}
                  options={modeOptions}
                  onChange={(mode) => setDraft(withMode(draft, mode))}
                />
                <DevicePicker
                  devices={parents}
                  listState={listState}
                  fleet={fleet}
                  value={[...draft.pickedIds]}
                  onChange={(next) => setDraft(withPickedIds(draft, next))}
                  emptyMeansAll={draft.mode === 'except'}
                  noun="device"
                  testId="viewer-device-picker"
                />
                <RolePreview scopes={request?.scopes ?? []} invalidReason={reasonText} />
              </section>

              <section className="space-y-2">
                <h3 className={SECTION_HEADING}>{t('users.userAccessModal.features')}</h3>
                <div className="space-y-1">
                  {VIEWER_FEATURES.map((feature) => (
                    <label
                      key={feature.id}
                      className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 hover:bg-surface-hover"
                    >
                      <Checkbox
                        className="mt-0.5"
                        checked={draft.viewer.features.includes(feature.id)}
                        onChange={(event) =>
                          setDraft(withFeature(draft, feature.id, event.target.checked))
                        }
                      />
                      <span className="min-w-0">
                        <span className="block text-[12px] font-medium text-foreground">
                          {t(`users.viewerFeatures.${feature.id}.label`, feature.label)}
                        </span>
                        <span className="block text-[10px] text-foreground-subtle">
                          {t(`users.viewerFeatures.${feature.id}.description`, feature.description)}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </section>
            </>
          )}

          {error !== null && <ErrorBox message={error} />}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            size="sm"
            onClick={() => request !== null && onSubmit(request)}
            disabled={submitting || request === null}
          >
            {submitting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              t('users.userAccessModal.saveAccess')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface RoleOptionProps {
  readonly name: string
  readonly checked: boolean
  readonly disabled?: boolean
  readonly label: string
  readonly description: string
  readonly onPick: () => void
}

/** One role as a radio card. */
function RoleOption({
  name,
  checked,
  disabled = false,
  label,
  description,
  onPick,
}: RoleOptionProps): React.ReactElement {
  return (
    <label
      className={`flex items-start gap-2 rounded-lg border p-2.5 transition-colors ${
        checked ? 'border-primary bg-primary/5' : 'border-border hover:bg-surface-hover'
      } ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
    >
      <input
        type="radio"
        name="user-role"
        value={name}
        checked={checked}
        disabled={disabled}
        onChange={onPick}
        className="mt-0.5"
      />
      <span className="min-w-0">
        <span className="block text-[12px] font-medium text-foreground">{label}</span>
        <span className="block text-[10px] text-foreground-subtle">{description}</span>
      </span>
    </label>
  )
}
