import { useState, useEffect, useCallback } from 'react'
import { X, Info, AlertTriangle, AlertCircle } from 'lucide-react'
import type { Toast } from '@camstack/types'
import { useToastOnToast, Button } from '@camstack/ui-library'
import { subscribeToasts } from './toast-bus'

interface ToastItem {
  id: string
  title: string
  message: string
  severity: 'info' | 'warning' | 'critical'
  duration?: number
  timestamp: number
}

const SEVERITY_STYLES: Record<string, { bg: string; border: string; icon: typeof Info }> = {
  info: { bg: 'bg-info/10', border: 'border-info/30', icon: Info },
  warning: { bg: 'bg-warning/10', border: 'border-warning/30', icon: AlertTriangle },
  critical: { bg: 'bg-danger/10', border: 'border-danger/30', icon: AlertCircle },
}

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: string) => void }) {
  const style = SEVERITY_STYLES[toast.severity] ?? SEVERITY_STYLES.info
  const Icon = style.icon

  useEffect(() => {
    const duration = toast.duration ?? 5000
    if (duration <= 0) return
    const timer = setTimeout(() => onDismiss(toast.id), duration)
    return () => clearTimeout(timer)
  }, [toast.id, toast.duration, onDismiss])

  return (
    <div
      className={`flex items-start gap-3 px-4 py-3 rounded-lg border ${style.border} ${style.bg} shadow-lg backdrop-blur-sm animate-in slide-in-from-right-5 fade-in duration-200`}
    >
      <Icon className="h-4 w-4 shrink-0 mt-0.5 text-foreground-subtle" />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold text-foreground">{toast.title}</div>
        <div className="text-[11px] text-foreground-subtle mt-0.5">{toast.message}</div>
      </div>
      <Button
        variant="unstyled"
        type="button"
        onClick={() => onDismiss(toast.id)}
        className="shrink-0 p-0.5 rounded hover:bg-surface-hover transition-colors"
      >
        <X className="h-3.5 w-3.5 text-foreground-subtle" />
      </Button>
    </div>
  )
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const add = useCallback((toast: Omit<ToastItem, 'id' | 'timestamp'>) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setToasts((prev) => [...prev, { ...toast, id, timestamp: Date.now() }])
  }, [])

  useToastOnToast(undefined, {
    onData: (value: unknown) => add(value as Toast),
  })

  useEffect(() => subscribeToasts(add), [add])

  if (toasts.length === 0) return null

  return (
    // `position: fixed` resolves against the viewport, bypassing the
    // `env(safe-area-inset-*)` padding AppLayout applies to the app shell.
    // Under `viewport-fit=cover` that puts a plain `bottom-4`/`right-4`
    // under the iOS home indicator (and under the notch in landscape).
    // Both offsets collapse to `1rem` when the insets are 0.
    <div className="fixed bottom-[calc(env(safe-area-inset-bottom)+1rem)] right-[calc(env(safe-area-inset-right)+1rem)] z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none">
      {toasts.map((toast) => (
        <div key={toast.id} className="pointer-events-auto">
          <ToastCard toast={toast} onDismiss={dismiss} />
        </div>
      ))}
    </div>
  )
}
