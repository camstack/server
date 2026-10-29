/**
 * The native desktop app's version and update state for one node, plus the
 * "Install update & restart" action. Rendered only when the node reports a
 * `desktopApp` (Docker nodes never do).
 *
 * `accepted: true` from `installDesktopUpdate` means only that the request was
 * WRITTEN. The restart is observed afterwards on `desktopApp.version`, so the
 * row shows "restarting…" until the version changes, and says so honestly if
 * that does not happen within {@link RESTART_TIMEOUT_MS}.
 */
import { Loader2, RotateCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, useConfirm, useServerManagementInstallDesktopUpdate } from '@camstack/ui-library'
import { formatRelativeTime } from '../../device/hero/format'

const RESTART_TIMEOUT_MS = 3 * 60_000

export interface DesktopAppState {
  readonly version: string
  readonly update: {
    readonly available: boolean
    readonly downloaded: boolean
    readonly version: string | null
    readonly checking: boolean
    readonly error: string | null
  }
  readonly stateAtMs: number
  readonly stale: boolean
}

type InstallRefusal = 'not-electron' | 'no-app-state' | 'app-state-stale' | 'not-downloaded'

interface NodeDesktopAppRowProps {
  readonly desktopApp: DesktopAppState
  readonly nodeName: string
  readonly routingInput: { readonly nodeId: string } | undefined
  readonly onSettled: () => void
}

interface InstallWatch {
  readonly fromVersion: string
  readonly startedAtMs: number
}

type Tone = 'neutral' | 'ok' | 'info' | 'warn' | 'error'

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'bg-surface-muted text-foreground-subtle',
  ok: 'bg-success/15 text-success',
  info: 'bg-info/15 text-info',
  warn: 'bg-warning/15 text-warning',
  error: 'bg-danger/15 text-danger',
}

export function NodeDesktopAppRow({
  desktopApp,
  nodeName,
  routingInput,
  onSettled,
}: NodeDesktopAppRowProps) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const install = useServerManagementInstallDesktopUpdate({ onSettled })
  const [watch, setWatch] = useState<InstallWatch | null>(null)
  const [timedOut, setTimedOut] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)

  // The restart landed: the app now reports a different version.
  useEffect(() => {
    if (watch != null && desktopApp.version !== watch.fromVersion) {
      setWatch(null)
      setTimedOut(false)
    }
  }, [desktopApp.version, watch])

  useEffect(() => {
    if (watch == null) return undefined
    const remaining = Math.max(0, watch.startedAtMs + RESTART_TIMEOUT_MS - Date.now())
    const timer = setTimeout(() => setTimedOut(true), remaining)
    return () => clearTimeout(timer)
  }, [watch])

  const refusalText = useCallback(
    (reason: InstallRefusal): string => {
      switch (reason) {
        case 'not-electron':
          return t(
            'serverManagement.desktopRefusedNotElectron',
            'This node does not run inside the desktop app.',
          )
        case 'no-app-state':
          return t(
            'serverManagement.desktopRefusedNoState',
            'The desktop app has not reported its state yet.',
          )
        case 'app-state-stale':
          return t(
            'serverManagement.desktopRefusedStale',
            'The desktop app stopped reporting — it is probably not running.',
          )
        case 'not-downloaded':
          return t('serverManagement.desktopRefusedNotDownloaded', 'No update is downloaded yet.')
      }
    },
    [t],
  )

  const handleInstall = useCallback(async (): Promise<void> => {
    const ok = await confirm({
      title: t('serverManagement.desktopConfirmTitle', 'Install desktop app update'),
      message: t(
        'serverManagement.desktopConfirmBody',
        'Install {{version}} on "{{node}}" and restart the desktop app? The node is offline while it restarts.',
        { version: desktopApp.update.version ?? '', node: nodeName },
      ),
      confirmLabel: t('serverManagement.desktopInstallAction', 'Install update & restart'),
      variant: 'warning',
    })
    if (!ok) return
    setRefusal(null)
    setTimedOut(false)
    try {
      const result = await install.mutateAsync(routingInput)
      if (result.accepted) {
        setWatch({ fromVersion: desktopApp.version, startedAtMs: Date.now() })
      } else if (result.reason != null) {
        setRefusal(refusalText(result.reason))
      }
    } catch (err) {
      setRefusal(err instanceof Error ? err.message : String(err))
    }
  }, [confirm, desktopApp, install, nodeName, refusalText, routingInput, t])

  const restarting = watch != null && !timedOut
  const { update } = desktopApp

  let badge: { readonly label: string; readonly tone: Tone } | null = null
  if (desktopApp.stale) {
    badge = {
      label: t('serverManagement.desktopStale', 'app state unknown (last seen {{when}})', {
        when: formatRelativeTime(desktopApp.stateAtMs),
      }),
      tone: 'warn',
    }
  } else if (update.downloaded) {
    badge = {
      label: t('serverManagement.desktopReady', 'update {{version}} ready', {
        version: update.version ?? '',
      }),
      tone: 'ok',
    }
  } else if (update.available) {
    badge = {
      label: t(
        'serverManagement.desktopDownloading',
        'update {{version}} available — downloading',
        {
          version: update.version ?? '',
        },
      ),
      tone: 'info',
    }
  } else if (update.checking) {
    badge = {
      label: t('serverManagement.stateChecking', 'checking…'),
      tone: 'info',
    }
  } else if (update.error == null) {
    badge = {
      label: t('serverManagement.stateUpToDate', 'up to date'),
      tone: 'ok',
    }
  }

  const canInstall = !desktopApp.stale && update.downloaded && !restarting && !install.isPending

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm">
        <span className="inline-flex items-baseline gap-1">
          <span className="text-foreground-subtle">
            {t('serverManagement.desktopApp', 'Desktop app')}
          </span>
          <span className="font-mono text-foreground">{desktopApp.version}</span>
        </span>
        {badge != null && (
          <span
            className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium ${TONE_CLASSES[badge.tone]}`}
          >
            {badge.label}
          </span>
        )}
      </div>

      {!desktopApp.stale && update.error != null && (
        <p className="text-xs text-danger">
          {t('serverManagement.desktopUpdateError', 'Update check failed: {{error}}', {
            error: update.error,
          })}
        </p>
      )}

      {canInstall && (
        <Button size="sm" onClick={() => void handleInstall()}>
          <RotateCw className="h-3.5 w-3.5" />
          {t('serverManagement.desktopInstallAction', 'Install update & restart')}
        </Button>
      )}

      {(install.isPending || restarting) && (
        <div className="flex items-center gap-2 text-sm text-warning">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t(
            'serverManagement.desktopRestarting',
            'The desktop app is restarting to install the update…',
          )}
        </div>
      )}

      {watch != null && timedOut && (
        <p role="status" className="text-xs text-warning">
          {t(
            'serverManagement.desktopRestartTimeout',
            'The desktop app has not come back with a new version after 3 minutes. Check the machine.',
          )}
        </p>
      )}

      {refusal != null && (
        <p role="status" className="text-xs text-warning">
          {refusal}
        </p>
      )}
    </div>
  )
}
