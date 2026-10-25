import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useDeviceManagerAdoptionResync } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'

interface ResyncButtonProps {
  deviceId: number
}

interface ResyncResult {
  changed: boolean
  rebuiltChildren: number
}

/**
 * Generic on-demand re-sync for any device that advertises
 * `DeviceFeature.Resyncable`. Calls `deviceManager.adoptionResync({camDeviceId})`
 * which routes to the device's OWNING integration's adoption provider (NOT the
 * singleton `device-adoption.resync`, which always hit one integration and
 * failed for everyone else), re-aligning the device's structural spec (type /
 * role / capabilities / units) with its upstream source and rebuilding any
 * child whose class changed while preserving operator edits.
 */
export function ResyncButton({ deviceId }: ResyncButtonProps) {
  const { t } = useTranslation()
  const [result, setResult] = useState<string | null>(null)
  const resync = useDeviceManagerAdoptionResync({
    onSuccess: (r: ResyncResult) => {
      setResult(
        r.changed
          ? `Re-aligned with source — ${r.rebuiltChildren} child${r.rebuiltChildren === 1 ? '' : 'ren'} rebuilt.`
          : 'Already up to date.',
      )
    },
    onError: (e) => setResult(`Re-sync failed: ${e.message}`),
  })

  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-foreground">
            {t('device.resyncButton.reSync', 'Re-sync')}
          </h2>
          <p className="mt-0.5 text-[11px] text-foreground-subtle">
            {t(
              'device.resyncButton.reAlignThisDeviceS',
              "Re-align this device's type, role, capabilities and units with its source.",
            )}
          </p>
        </div>
        <button
          type="button"
          disabled={resync.isPending}
          onClick={() => {
            setResult(null)
            resync.mutate({ camDeviceId: deviceId })
          }}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${resync.isPending ? 'animate-spin' : ''}`} />
          {resync.isPending
            ? t('device.resyncButton.reSyncing', 'Re-syncing…')
            : t('device.resyncButton.reSync', 'Re-sync')}
        </button>
      </div>
      {result !== null && <p className="mt-2 text-[11px] text-foreground-subtle">{result}</p>}
    </div>
  )
}
