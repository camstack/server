import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Eye } from 'lucide-react'

interface SnapshotPopoverProps {
  deviceName: string
  snapshotUrl?: string | null
  status: string
  resolution?: string | null
  codec?: string | null
  fps?: number | null
  lastSnapshot?: string | null
}

export function SnapshotPopover({
  deviceName,
  snapshotUrl,
  status,
  resolution,
  codec,
  fps,
  lastSnapshot,
}: SnapshotPopoverProps) {
  const { t } = useTranslation()
  const [showPopover, setShowPopover] = useState(false)

  return (
    <div
      className="relative flex-shrink-0"
      onMouseEnter={() => setShowPopover(true)}
      onMouseLeave={() => setShowPopover(false)}
    >
      <button
        className="flex h-6 w-6 items-center justify-center rounded text-foreground-subtle hover:bg-surface-hover hover:text-foreground transition-colors"
        title={t('integrations.preview')}
      >
        <Eye className="h-3.5 w-3.5" />
      </button>

      {showPopover && (
        <div className="absolute bottom-full right-0 mb-2 w-72 rounded-lg border border-border bg-surface shadow-lg shadow-black/30 z-50 overflow-hidden">
          <div className="h-40 bg-background flex items-center justify-center">
            {snapshotUrl && status !== 'offline' && status !== 'disabled' ? (
              <img
                src={snapshotUrl}
                alt={deviceName}
                className="h-full w-full object-cover"
                onError={(e) => {
                  ;(e.target as HTMLImageElement).style.display = 'none'
                }}
              />
            ) : (
              <span className="text-xs text-foreground-subtle">
                {status === 'offline'
                  ? t('integrations.snapshotUnavailable')
                  : t('integrations.noSnapshot')}
              </span>
            )}
          </div>
          <div className="px-3 py-2 space-y-0.5">
            <p className="text-xs font-semibold text-foreground">{deviceName}</p>
            {(resolution || codec || fps) && (
              <p className="text-[10px] text-foreground-subtle">
                {[codec, resolution, fps ? `${fps}fps` : null].filter(Boolean).join(' · ')}
              </p>
            )}
            {lastSnapshot && (
              <p className="text-[10px] text-foreground-subtle">
                {t('integrations.lastSnapshot')} {lastSnapshot}
              </p>
            )}
            {status === 'offline' && (
              <p className="text-[10px] text-danger">{t('integrations.offline')}</p>
            )}
            {status === 'disabled' && (
              <p className="text-[10px] text-warning">
                {t('integrations.snapshotPopover.disabled', 'Disabled')}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
