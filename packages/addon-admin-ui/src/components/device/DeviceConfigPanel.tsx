/**
 * DeviceConfigPanel — renders config for a device using FormBuilder.
 *
 * Config entries from the tRPC router are serialized { key, value, description? }
 * objects — NOT Zod types. We build a simple ConfigUISchema with 'text' fields
 * for each entry (values rendered as-is) and save via useUpdateDeviceConfig.
 */
import { useState, useEffect } from 'react'
import { Save } from 'lucide-react'
import { FormBuilder } from '../form-builder/FormBuilder.js'
import { useDeviceConfig, useUpdateDeviceConfig } from '../../hooks/useDevice.js'
import type { ConfigUISchema } from '../../types/config-ui.js'
import type { DeviceConfigEntry } from '../../hooks/useDevice.js'
import { useTranslation } from 'react-i18next'
import { Button } from '@camstack/ui-library'

// ---------------------------------------------------------------------------
// Adapter: serialized config entries → ConfigUISchema
// ---------------------------------------------------------------------------

function humanizeKey(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_-]/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase())
    .trim()
}

function inferFieldType(key: string, value: unknown): 'text' | 'number' | 'boolean' | 'password' {
  const lowerKey = key.toLowerCase()
  if (
    lowerKey.includes('password') ||
    lowerKey.includes('secret') ||
    lowerKey.includes('token') ||
    lowerKey.includes('apikey') ||
    lowerKey.includes('api_key')
  ) {
    return 'password'
  }
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  return 'text'
}

function serializedEntriesToConfigUI(
  entries: readonly DeviceConfigEntry[],
  sectionTitle = 'Configuration',
  sectionId = 'main',
): ConfigUISchema {
  return {
    sections: [
      {
        id: sectionId,
        title: sectionTitle,
        fields: entries.map((entry) => {
          const fieldType = inferFieldType(entry.key, entry.value)
          const base = {
            key: entry.key,
            label: humanizeKey(entry.key),
            description: entry.description,
          }
          if (fieldType === 'password') {
            return { ...base, type: 'password' as const, showToggle: true }
          }
          if (fieldType === 'boolean') {
            return { ...base, type: 'boolean' as const }
          }
          if (fieldType === 'number') {
            return { ...base, type: 'number' as const }
          }
          return { ...base, type: 'text' as const }
        }),
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface DeviceConfigPanelProps {
  /** Numeric device id — the canonical handle. `addonId` is no longer
   *  required (the deviceManager caps resolve the owning addon from
   *  the numeric id), but kept in the prop surface for callers that
   *  still pass it. */
  deviceId: number
  addonId?: string
  /** Optional title for the config section. Defaults to 'Configuration'. */
  sectionTitle?: string
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DeviceConfigPanel({
  deviceId,
  sectionTitle = 'Configuration',
}: DeviceConfigPanelProps) {
  const { t } = useTranslation()
  const { data: entries, isLoading, isError } = useDeviceConfig(deviceId)
  const updateConfig = useUpdateDeviceConfig(deviceId)

  const [localValues, setLocalValues] = useState<Record<string, unknown>>({})
  const [dirty, setDirty] = useState(false)

  // Sync local values when entries load / change
  useEffect(() => {
    if (!entries) return
    const initial = Object.fromEntries(entries.map((e) => [e.key, e.value]))
    setLocalValues(initial)
    setDirty(false)
  }, [entries])

  const handleChange = (values: Record<string, unknown>) => {
    setLocalValues(values)
    setDirty(true)
  }

  const handleSave = () => {
    updateConfig.mutate(
      { deviceId, values: localValues },
      {
        onSuccess: () => setDirty(false),
      },
    )
  }

  if (isLoading) {
    return <div className="h-20 rounded-lg border border-border bg-surface animate-pulse" />
  }

  if (isError) {
    return (
      <div className="rounded-lg border border-border bg-surface p-4 text-xs text-danger">
        {t(
          'device.deviceConfigPanel.failedToLoadDeviceConfiguration',
          'Failed to load device configuration.',
        )}
      </div>
    )
  }

  if (!entries || entries.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-4 text-xs text-foreground-subtle">
        {t(
          'device.deviceConfigPanel.noConfigurationAvailableForThis',
          'No configuration available for this device.',
        )}
      </div>
    )
  }

  const schema = serializedEntriesToConfigUI(entries, sectionTitle)

  return (
    <div className="space-y-3">
      {dirty && (
        <div className="flex justify-end">
          <Button
            variant="unstyled"
            onClick={handleSave}
            disabled={updateConfig.isPending}
            className="inline-flex items-center gap-1 rounded px-2.5 py-1 text-[10px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            <Save className="h-3 w-3" />
            {updateConfig.isPending
              ? t('device.deviceConfigPanel.saving', 'Saving...')
              : t('common.save', 'Save')}
          </Button>
        </div>
      )}
      <FormBuilder
        schema={schema}
        values={localValues}
        onChange={handleChange}
        disabled={updateConfig.isPending}
      />
    </div>
  )
}
