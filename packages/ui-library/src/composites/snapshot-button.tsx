/**
 * SnapshotButton — operator-facing manual snapshot trigger.
 *
 * Two actions in one button:
 *   - Single click → invalidate the wrapper's cache, refetch a fresh
 *     snapshot, and open a download dialog with the resulting JPEG.
 *   - Hold (long-press, 600ms+) → same fetch but copy the data URL to
 *     the clipboard instead of downloading. Useful for quick paste
 *     into chat / docs.
 *
 * The component owns no React-Query state — it accepts a tRPC mutation
 * + query proxy and lets the caller decide invalidation / refetch
 * cadence. Returns null if the device id is invalid so call-sites can
 * drop it in unconditionally.
 */
import { Camera, Loader2, Check } from 'lucide-react'
import { useState, useCallback, type JSX } from 'react'
import { cn } from '../lib/cn'
import { useUiText } from '../contexts/ui-text'

interface QueryFn<I, O> {
  query(input: I): Promise<O>
}

export interface SnapshotButtonTrpc {
  readonly snapshot: {
    readonly getSnapshot: QueryFn<
      { deviceId: number; streamId?: string; force?: boolean },
      { base64: string; contentType: string } | null
    >
  }
}

export interface SnapshotButtonProps {
  readonly trpc: SnapshotButtonTrpc
  readonly deviceId: number
  readonly deviceName: string
  /** Visual size — `'sm'` for header / tile, `'md'` for prominent CTA. */
  readonly size?: 'sm' | 'md'
  readonly className?: string
}

function downloadDataUrl(filename: string, dataUrl: string): void {
  const link = document.createElement('a')
  link.href = dataUrl
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

export function SnapshotButton({
  trpc,
  deviceId,
  deviceName,
  size = 'sm',
  className,
}: SnapshotButtonProps): JSX.Element {
  const t = useUiText()
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const safeName = deviceName.replace(/[^a-zA-Z0-9_.-]+/g, '_')

  const fetchSnapshot = useCallback(
    async (action: 'download' | 'copy') => {
      setBusy(true)
      setError(null)
      setDone(false)
      try {
        // Manual user action — pass `force: true` to bypass the wrapper's
        // freshness gate and capture a brand-new frame. On battery cams
        // this WILL wake the camera; that's the explicit operator intent
        // when the snapshot button is clicked.
        const result = await trpc.snapshot.getSnapshot.query({ deviceId, force: true })
        if (!result) throw new Error('No snapshot available')
        const url = `data:${result.contentType};base64,${result.base64}`
        if (action === 'copy') {
          try {
            await navigator.clipboard.writeText(url)
          } catch {
            throw new Error('Clipboard unavailable')
          }
        } else {
          const ext = result.contentType.includes('png') ? 'png' : 'jpg'
          const ts = new Date().toISOString().replace(/[:.]/g, '-')
          downloadDataUrl(`${safeName}-${ts}.${ext}`, url)
        }
        setDone(true)
        // Auto-clear the success indicator after 1.5s.
        setTimeout(() => setDone(false), 1500)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [trpc, deviceId, safeName],
  )

  const sizeClasses = size === 'md' ? 'h-9 px-3 text-sm gap-2' : 'h-7 px-2.5 text-[11px] gap-1.5'

  // Long-press detection: if the button is held > 600ms, the action
  // becomes "copy data URL" instead of "download".
  const [pressTimer, setPressTimer] = useState<ReturnType<typeof setTimeout> | null>(null)
  const [longPressed, setLongPressed] = useState(false)

  const handlePointerDown = () => {
    setLongPressed(false)
    const timer = setTimeout(() => {
      setLongPressed(true)
      void fetchSnapshot('copy')
    }, 600)
    setPressTimer(timer)
  }

  const handlePointerUp = () => {
    if (pressTimer) {
      clearTimeout(pressTimer)
      setPressTimer(null)
    }
    if (!longPressed) void fetchSnapshot('download')
  }

  const handlePointerCancel = () => {
    if (pressTimer) {
      clearTimeout(pressTimer)
      setPressTimer(null)
    }
  }

  return (
    <button
      type="button"
      title={t('uiLibrary.snapshotButton.title', 'Click to download · long-press to copy')}
      disabled={busy}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerCancel}
      onPointerCancel={handlePointerCancel}
      className={cn(
        'inline-flex items-center justify-center rounded-lg font-medium border border-border',
        'text-foreground-subtle hover:text-foreground hover:bg-surface-hover',
        'disabled:opacity-50 transition-colors',
        sizeClasses,
        error && 'border-danger/40 text-danger',
        className,
      )}
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : done ? (
        <Check className="h-3.5 w-3.5 text-success" />
      ) : (
        <Camera className="h-3.5 w-3.5" />
      )}
      {t('uiLibrary.snapshotButton.snapshot', 'Snapshot')}
    </button>
  )
}
