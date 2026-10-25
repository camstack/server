/**
 * Profile picker for the Alarm tab — switch / create / clone / rename / delete.
 *
 * The Default profile is always present and cannot be deleted. Creating without
 * a clone source starts at system defaults; cloning copies the selected profile.
 */
import type { NcAlarmProfilesView } from '@camstack/types'
import { Button, Input } from '@camstack/ui-library'
import { Copy, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

interface AlarmProfileBarProps {
  readonly profiles: NcAlarmProfilesView
  readonly busy: boolean
  readonly onActivate: (id: string) => void
  readonly onCreate: (name: string) => void
  readonly onClone: (fromId: string, name: string) => void
  readonly onRename: (id: string, name: string) => void
  readonly onDelete: (id: string) => void
}

export function AlarmProfileBar({
  profiles,
  busy,
  onActivate,
  onCreate,
  onClone,
  onRename,
  onDelete,
}: AlarmProfileBarProps) {
  const { t } = useTranslation()
  const [draftName, setDraftName] = useState('')
  const [renaming, setRenaming] = useState(false)
  const active = profiles.items.find((p) => p.id === profiles.activeId) ?? profiles.items[0]
  const canDelete = active !== undefined && !active.isDefault

  const trimmed = draftName.trim()
  const submitCreate = (): void => {
    if (trimmed.length === 0) return
    onCreate(trimmed)
    setDraftName('')
  }
  const submitClone = (): void => {
    if (trimmed.length === 0 || active === undefined) return
    onClone(active.id, trimmed)
    setDraftName('')
  }
  const submitRename = (): void => {
    if (trimmed.length === 0 || active === undefined) return
    onRename(active.id, trimmed)
    setDraftName('')
    setRenaming(false)
  }

  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-border bg-surface-1 p-3"
      data-testid="alarm-profiles"
    >
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs font-medium text-foreground-muted" htmlFor="alarm-profile-select">
          {t('system.alarmProfileBar.profile', 'Profile')}
        </label>
        <select
          id="alarm-profile-select"
          className="h-8 min-w-[10rem] rounded-md border border-border bg-background px-2 text-sm"
          data-testid="alarm-profile-select"
          disabled={busy}
          value={profiles.activeId}
          onChange={(e) => onActivate(e.target.value)}
        >
          {profiles.items.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.isDefault ? ` (${t('system.alarmProfileBar.defaultSuffix')})` : ''}
            </option>
          ))}
        </select>
        {canDelete ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            data-testid="alarm-profile-delete"
            title={t('system.alarmProfileBar.deleteThisProfile', 'Delete this profile')}
            onClick={() => {
              if (active !== undefined) onDelete(active.id)
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="h-8 max-w-[14rem]"
          data-testid="alarm-profile-name"
          placeholder={
            renaming
              ? t('system.alarmProfileBar.newName', 'New name')
              : t('system.alarmProfileBar.newProfileName', 'New profile name')
          }
          value={draftName}
          disabled={busy}
          onChange={(e) => setDraftName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            if (renaming) submitRename()
            else submitCreate()
          }}
        />
        {renaming ? (
          <>
            <Button
              type="button"
              size="sm"
              disabled={busy || trimmed.length === 0}
              data-testid="alarm-profile-rename-save"
              onClick={submitRename}
            >
              {t('system.alarmProfileBar.rename', 'Rename')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              data-testid="alarm-profile-rename-cancel"
              onClick={() => {
                setRenaming(false)
                setDraftName('')
              }}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              size="sm"
              disabled={busy || trimmed.length === 0}
              data-testid="alarm-profile-create"
              title={t(
                'system.alarmProfileBar.createWithSystemDefaults',
                'Create with system defaults',
              )}
              onClick={submitCreate}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t('system.alarmProfileBar.create', 'Create')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy || trimmed.length === 0 || active === undefined}
              data-testid="alarm-profile-clone"
              title={t(
                'system.alarmProfileBar.cloneTheSelectedProfile',
                'Clone the selected profile',
              )}
              onClick={submitClone}
            >
              <Copy className="mr-1 h-3.5 w-3.5" />
              {t('system.alarmProfileBar.clone', 'Clone')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy || active === undefined}
              data-testid="alarm-profile-rename"
              onClick={() => {
                setRenaming(true)
                setDraftName(active?.name ?? '')
              }}
            >
              {t('system.alarmProfileBar.rename', 'Rename')}
            </Button>
          </>
        )}
      </div>
      <p className="text-[11px] text-foreground-subtle">
        {t(
          'system.alarmProfileBar.createStartsFromSystemDefaults',
          'Create starts from system defaults. Clone copies the selected profile (sensors, secure-on-arm, delays). Switching applies that profile for the next arm.',
        )}
      </p>
    </div>
  )
}
