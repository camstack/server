import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Camera, Check } from 'lucide-react'

import { useDeviceManagerDiscoverDevices } from '@camstack/ui-library'
interface DeviceDiscoveryStepProps {
  providerId: string
  onImport: (externalIds: readonly string[]) => void
  onSkip: () => void
}

export function DeviceDiscoveryStep({ providerId, onImport, onSkip }: DeviceDiscoveryStepProps) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())

  const discoverMutation = useDeviceManagerDiscoverDevices()
  const discovered = discoverMutation.data
  const isLoading =
    discoverMutation.isPending || (!discoverMutation.data && !discoverMutation.isError)

  useEffect(() => {
    if (!providerId) return
    if (discoverMutation.isPending || discoverMutation.data) return
    discoverMutation.mutate({ addonId: providerId })
  }, [providerId, discoverMutation])

  function toggleDevice(externalId: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(externalId)) {
        next.delete(externalId)
      } else {
        next.add(externalId)
      }
      return next
    })
  }

  if (isLoading) {
    return (
      <div className="flex flex-col items-center py-12">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <p className="mt-3 text-xs text-foreground-subtle">{t('integrations.searchingDevices')}</p>
      </div>
    )
  }

  const devices = discovered ?? []

  return (
    <div className="space-y-4">
      <p className="text-xs text-foreground-subtle">
        {devices.length > 0
          ? t('integrations.foundDevices', { count: devices.length })
          : t('integrations.noDevicesFound')}
      </p>

      {devices.length > 0 && (
        <div className="space-y-1.5 max-h-64 overflow-y-auto">
          {devices.map((device) => {
            const id = device.stableId
            const name = device.suggestedName ?? id
            const isSelected = selected.has(id)
            // A device the provider already owns is shown, but never selectable.
            // Re-adopting one overwrites its config from scan-derived values — that is
            // how a Reolink Home Hub's Baichuan port became its ONVIF port, taking the
            // hub and its three cameras offline. Hiding it would answer the operator's
            // "where is my camera?" with silence, so it is named and disabled instead.
            const owned = device.alreadyOnboarded === true

            return (
              <button
                key={id}
                onClick={() => {
                  if (!owned) toggleDevice(id)
                }}
                disabled={owned}
                title={
                  owned
                    ? t('integrations.alreadyAddedHint', {
                        defaultValue:
                          'Already added as "{{name}}" — re-adding would overwrite its settings.',
                        name: device.onboardedName ?? name,
                      })
                    : undefined
                }
                className={`flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
                  owned
                    ? 'border-border bg-surface opacity-60 cursor-not-allowed'
                    : isSelected
                      ? 'border-primary/40 bg-primary/5'
                      : 'border-border bg-surface hover:border-foreground-subtle/30'
                }`}
              >
                <div
                  className={`flex h-5 w-5 items-center justify-center rounded border flex-shrink-0 ${
                    isSelected && !owned ? 'border-primary bg-primary' : 'border-border'
                  }`}
                >
                  {isSelected && !owned && <Check className="h-3 w-3 text-primary-foreground" />}
                </div>
                <Camera className="h-3.5 w-3.5 text-foreground-subtle flex-shrink-0" />
                <span className="text-xs font-medium text-foreground truncate">{name}</span>
                {owned && (
                  <span className="ml-auto flex-shrink-0 rounded bg-surface-muted px-1.5 py-0.5 text-[10px] font-medium text-foreground-subtle">
                    {t('integrations.alreadyAdded', { defaultValue: 'Already added' })}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}

      <div className="flex items-center justify-between pt-2">
        <button
          onClick={onSkip}
          className="rounded-lg border border-border px-3 py-1.5 text-xs text-foreground-subtle hover:text-foreground transition-colors"
        >
          {t('integrations.skip')}
        </button>
        {devices.length > 0 && (
          <button
            onClick={() => onImport(Array.from(selected))}
            disabled={selected.size === 0}
            className="rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground shadow-sm disabled:opacity-50"
          >
            {t('integrations.importSelected')} ({selected.size})
          </button>
        )}
      </div>
    </div>
  )
}
