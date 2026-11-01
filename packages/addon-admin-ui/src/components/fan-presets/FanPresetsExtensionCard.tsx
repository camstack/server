/**
 * The fan presets' card on a fan's Customize tab: the presets the operator
 * authored (a name and the steps it runs on the fan and its siblings), with add,
 * edit and delete. They are listed as actions, so Alexa, HomeKit and Home
 * Assistant offer them without more setup. It claims "no presets" only from a
 * read that answered.
 */
import type { DeviceInfo, FanPreset } from '@camstack/types'
import {
  Badge,
  Button,
  IconButton,
  useConfirm,
  useDeviceManagerListAll,
  useFanPresetsGetPresets,
  useFanPresetsSetPresets,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { Fan, Pencil, Plus, Trash2 } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AutomationDevice } from '../../pages/build/automation/automation-data'
import { CustomizeCard } from '../device/customize/CustomizeCard'
import { FanPresetDialog } from './FanPresetDialog'
import { newPresetId, removePreset, siblingIds, upsertPreset } from './fan-presets-model'

export interface FanPresetsExtensionCardProps {
  readonly device: DeviceInfo
}

function useScopeDevices(device: DeviceInfo): readonly AutomationDevice[] {
  const fleet = useDeviceManagerListAll({ projection: 'slim' })
  return useMemo((): readonly AutomationDevice[] => {
    const all = fleet.data ?? []
    const ids = new Set(siblingIds(all, device))
    return all
      .filter((d) => ids.has(d.id))
      .map((d) => ({
        id: d.id,
        name: d.name,
        stableId: d.stableId,
        type: String(d.type),
        location: d.location ?? null,
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name))
  }, [fleet.data, device])
}

export function FanPresetsExtensionCard({ device }: FanPresetsExtensionCardProps): ReactNode {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const queryClient = useQueryClient()
  const presets = useFanPresetsGetPresets({ deviceId: device.id })
  const scope = useScopeDevices(device)
  const [editing, setEditing] = useState<FanPreset | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const save = useFanPresetsSetPresets({
    onSuccess: (result) => {
      if (result.status === 'refused') {
        setRefusal(result.detail)
        return
      }
      setRefusal(null)
      setEditing(null)
      void queryClient.invalidateQueries({ queryKey: [['fanPresets']] })
      void queryClient.invalidateQueries({ queryKey: [['actions']] })
    },
  })
  const stored = presets.data

  const saveList = (list: readonly FanPreset[]): void =>
    save.mutate({ deviceId: device.id, presets: [...list] })

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
          onClick={() => setEditing({ id: newPresetId(stored ?? []), name: '', steps: [] })}
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
            'No presets yet. A preset sets the fan, and the lamp or switch beside it, in one go.',
          )}
        </p>
      ) : (
        <ul className="divide-y divide-border-subtle" data-testid="fan-presets-list">
          {stored.map((preset) => (
            <li key={preset.id} className="flex items-center gap-2 px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{preset.name}</span>
              <Badge variant="info">
                {t('fanPresets.card.steps', 'Steps: {{count}}', {
                  count: preset.steps.length,
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
                    message: t(
                      'fanPresets.card.deleteMessage',
                      '{{name}} will be deleted, and Alexa, HomeKit and Home Assistant stop offering it.',
                      { name: preset.name },
                    ),
                    confirmLabel: t('common.delete', 'Delete'),
                    variant: 'danger',
                  }).then((accepted) => {
                    if (accepted) saveList(removePreset(stored, preset.id))
                  })
                }}
              />
            </li>
          ))}
        </ul>
      )}
      {editing !== null && stored !== undefined && (
        <FanPresetDialog
          fanId={device.id}
          draft={editing}
          others={stored}
          devices={scope}
          saving={save.isPending}
          error={refusal ?? save.error?.message ?? null}
          onSave={(preset) => saveList(upsertPreset(stored, preset))}
          onClose={() => {
            setEditing(null)
            setRefusal(null)
          }}
        />
      )}
    </CustomizeCard>
  )
}
