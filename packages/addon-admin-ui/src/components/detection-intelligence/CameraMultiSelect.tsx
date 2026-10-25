/**
 * CameraMultiSelect — a compact dropdown for narrowing the face gallery to one
 * or more cameras. Cameras are the distinct devices present in the fetched
 * faces, resolved to their human names. Selection is client-side only.
 */
import { useEffect, useRef, useState } from 'react'
import { Camera, Check, ChevronDown } from 'lucide-react'
import type { CameraOption } from './types.js'
import { useTranslation } from 'react-i18next'

interface CameraMultiSelectProps {
  readonly cameras: readonly CameraOption[]
  readonly selected: ReadonlySet<number>
  readonly onChange: (next: Set<number>) => void
}

export function CameraMultiSelect({ cameras, selected, onChange }: CameraMultiSelectProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    function onDocClick(e: globalThis.MouseEvent) {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) {
        setOpen(false)
      }
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  function toggle(id: number) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange(next)
  }

  const count = selected.size
  const label =
    count === 0
      ? 'All cameras'
      : count === 1
        ? (cameras.find((c) => selected.has(c.id))?.name ?? '1 camera')
        : `${String(count)} cameras`

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={cameras.length === 0}
        className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors disabled:opacity-40 ${
          count > 0
            ? 'border-primary/40 bg-primary/8 text-primary'
            : 'border-border text-foreground-subtle hover:bg-surface-hover hover:text-foreground'
        }`}
      >
        <Camera className="h-3.5 w-3.5" />
        <span className="max-w-[10rem] truncate">{label}</span>
        <ChevronDown className="h-3 w-3 opacity-70" />
      </button>

      {open && (
        <div className="absolute left-0 z-30 mt-1 max-h-64 w-[min(15rem,calc(100vw-1.5rem))] overflow-y-auto rounded-md border border-border bg-surface p-1 shadow-lg shadow-black/30">
          {count > 0 && (
            <button
              type="button"
              onClick={() => onChange(new Set())}
              className="mb-1 w-full rounded px-2 py-1 text-left text-[11px] text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
            >
              {t('detectionIntelligence.cameraMultiSelect.clearSelection', 'Clear selection')}
            </button>
          )}
          {cameras.map((cam) => {
            const isSel = selected.has(cam.id)
            return (
              <button
                key={cam.id}
                type="button"
                onClick={() => toggle(cam.id)}
                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
                  isSel ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-surface-hover'
                }`}
              >
                <span
                  className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border ${
                    isSel ? 'border-primary bg-primary text-white' : 'border-border'
                  }`}
                >
                  {isSel && <Check className="h-2.5 w-2.5" />}
                </span>
                <span className="truncate">{cam.name}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
