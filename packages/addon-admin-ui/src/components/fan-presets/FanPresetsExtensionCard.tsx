/**
 * The fan presets' card on a fan's Customize tab: the presets the operator
 * authored (a name and the fan-control state it sets, D1034), with add,
 * edit and delete. They are listed as actions, so Alexa, HomeKit and Home
 * Assistant offer them without more setup. It claims "no presets" only from a
 * read that answered. Every edit changes the tab's draft list (planning#675):
 * the tab's Save writes it, Discard restores what the fan stores.
 */
import type { DeviceInfo, FanPreset } from '@dominevo/types'
import {
  Badge,
  Button,
  IconButton,
  useConfirm,
  useFanPresetsGetPresets,
} from '@dominevo/ui-library'
import { Fan, Pencil, Plus, Trash2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CustomizeCard } from '../device/customize/CustomizeCard'
import { useConfigDraft } from '../device/customize/config/config-draft'
import { FanPresetDialog } from './FanPresetDialog'
import { newPresetId, presetFieldCount, removePreset, upsertPreset } from './fan-presets-model'

export interface FanPresetsExtensionCardProps {
  readonly device: DeviceInfo
}

export function FanPresetsExtensionCard({ device }: FanPresetsExtensionCardProps): ReactNode {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const presets = useFanPresetsGetPresets({ deviceId: device.id })
  const draft = useConfigDraft()
  const [editing, setEditing] = useState<FanPreset | null>(null)
  // Why an edit was not kept: the tab has no draft to keep it in, so it is said, never dropped.
  const [refusal, setRefusal] = useState<string | null>(null)
  // What the card shows: the draft list when the operator edited one, else what the fan stores.
  const stored = draft?.fanPresets ?? presets.data

  // An edit that lands back on the stored list is no edit: the draft is dropped.
  const keepList = (list: readonly FanPreset[]): string | null => {
    if (draft === null) {
      const reason = t('customize.table.keepUnavailable')
      setRefusal(reason)
      return reason
    }
    setRefusal(null)
    draft.setFanPresets(device, JSON.stringify(list) === JSON.stringify(presets.data) ? null : list)
    return null
  }

  return (
    <CustomizeCard
      id="fan-presets"
      title={t('fanPresets.card.title', 'Presets')}
      icon={Fan}
      testId="customize-fan-presets"
      actions={
        <Button
          size="sm"
          variant="outline"
          disabled={stored === undefined}
          onClick={() => setEditing({ id: newPresetId(stored ?? []), name: '', state: {} })}
          data-testid="fan-presets-add"
        >
          <Plus className="h-4 w-4" /> {t('fanPresets.card.add', 'Add preset')}
        </Button>
      }
    >
      {presets.status === 'error' ? (
        <p role="alert" className="px-3 py-2 text-xs text-danger">
          {presets.error?.message ??
            t('fanPresets.card.unreadable', 'The presets could not be read.')}
        </p>
      ) : stored === undefined ? (
        <p role="status" className="px-3 py-2 text-xs text-foreground-subtle">
          {t('fanPresets.card.loading', 'Loading presets…')}
        </p>
      ) : stored.length === 0 ? (
        <p className="px-3 py-2 text-xs text-foreground-muted" data-testid="fan-presets-empty">
          {t(
            'fanPresets.card.none',
            'No presets yet. A preset sets the fan’s speed, mode, direction and oscillation in one go.',
          )}
        </p>
      ) : (
        <ul className="divide-y divide-border-subtle" data-testid="fan-presets-list">
          {stored.map((preset) => (
            <li key={preset.id} className="flex items-center gap-2 px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{preset.name}</span>
              <Badge variant="info">
                {t('fanPresets.card.fields', 'Values: {{count}}', {
                  count: presetFieldCount(preset.state),
                })}
              </Badge>
              <IconButton
                icon={Pencil}
                variant="ghost"
                aria-label={t('fanPresets.card.edit', 'Edit {{name}}', {
                  name: preset.name,
                })}
                onClick={() => setEditing(preset)}
              />
              <IconButton
                icon={Trash2}
                variant="ghost"
                aria-label={t('fanPresets.card.delete', 'Delete {{name}}', {
                  name: preset.name,
                })}
                onClick={() => {
                  void confirm({
                    title: t('fanPresets.card.deleteTitle', 'Delete this preset?'),
                    message: t('customize.table.fanPresetDeleteWarning', { name: preset.name }),
                    confirmLabel: t('common.delete', 'Delete'),
                    variant: 'danger',
                  }).then((accepted) => {
                    if (accepted) keepList(removePreset(stored, preset.id))
                  })
                }}
              />
            </li>
          ))}
        </ul>
      )}
      {refusal !== null && editing === null && (
        <p role="alert" className="px-3 py-2 text-xs text-danger" data-testid="fan-presets-refusal">
          {refusal}
        </p>
      )}
      {editing !== null && stored !== undefined && (
        <FanPresetDialog
          fanId={device.id}
          draft={editing}
          others={stored}
          saving={false}
          error={refusal}
          onSave={(preset) => {
            if (keepList(upsertPreset(stored, preset)) === null) setEditing(null)
          }}
          onClose={() => {
            setEditing(null)
            setRefusal(null)
          }}
        />
      )}
    </CustomizeCard>
  )
}
