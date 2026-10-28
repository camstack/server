import {
  ErrorBox,
  SectionCard,
  SettingRow,
  SECTION_BODY,
  Badge,
  Button,
} from '@camstack/ui-library'
/**
 * Updates card — the agent UI could restart a node but never update one.
 *
 * This card is the FRAMEWORK (`@camstack/server`) only — a real, local action.
 * The node resolves `latest` and installs the closure straight from the npm
 * registry; the hub is not involved at any step. This is what an isolated or
 * misaligned node needs, and it works with the hub down.
 *
 * Addons are NOT here: they are rows of the single addon list (`addons-panel.tsx`),
 * and their update goes through the hub, which decides each node's addon version.
 *
 * Every failure is rendered. The precedent is one screen up in `page.tsx`
 * (`AppVersionBadge`): the desktop updater had an `error` field that nothing
 * displayed, so a failing check redrew exactly like a successful one and the
 * operator pressed a button that did nothing, three times.
 *
 * Runtime: build this package, then `camstack deploy addon-agent-ui` (the
 * runner loads from `<dataDir>/addons/`, not the workspace `dist/`).
 */
import { Download, Info, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { UnauthorizedError, fetchJson, postJson } from './api-client'
import { type AgentUiT, translate, useT } from './i18n'

// ---------------------------------------------------------------------------
// Wire types — mirror `server/backend/src/agent/agent-update-routes.ts`
// ---------------------------------------------------------------------------

type ServerUpdateState = 'idle' | 'checking' | 'staging' | 'pending-restart'

interface ServerPackageStatus {
  readonly packageName: string
  readonly runningVersion: string | null
  readonly latestVersion: string | null
  readonly updateAvailable: boolean
  readonly updateState: ServerUpdateState
  readonly pendingVersion: string | null
  readonly bootMode: string
  readonly lastCheckedAtMs: number | null
}

interface ServerUpdateActionResult {
  readonly accepted: boolean
  readonly targetVersion: string | null
  readonly restarting: boolean
  readonly message: string
}

interface ServerUpdateView {
  readonly status: ServerPackageStatus
  readonly lastCheckError: string | null
  readonly lastApply: ServerUpdateActionResult | null
  readonly applyInFlight: boolean
}

type ServerUpdateResponse =
  | ({ readonly available: true } & ServerUpdateView)
  | { readonly available: false; readonly reason: string }

interface ServerUpdateStartResult {
  readonly started: boolean
  readonly message: string | null
}

/**
 * Where this node's code was loaded from (`ServerBootMode`): not a data
 * location — a node has ONE data dir. `data-root` is the closure the node
 * updated itself into, `baked` the read-only copy shipped in the image.
 */
export function bootModeLabel(t: AgentUiT, bootMode: string): string {
  switch (bootMode) {
    case 'data-root':
      return t('updates.bootMode.dataRoot')
    case 'baked':
      return t('updates.bootMode.baked')
    case 'workspace':
      return t('updates.bootMode.workspace')
    default:
      return bootMode
  }
}

// ---------------------------------------------------------------------------
// Small presentational bits
// ---------------------------------------------------------------------------

function NoteLine({ text }: { readonly text: string }) {
  return (
    <div className="flex items-start gap-1.5 text-[11px] text-foreground-subtle">
      <Info className="h-3 w-3 shrink-0 mt-px" />
      <span>{text}</span>
    </div>
  )
}

function stateLabel(
  t: AgentUiT,
  state: ServerUpdateState,
  pendingVersion: string | null,
): string | null {
  if (state === 'checking') return t('updates.state.checking')
  if (state === 'staging') return t('updates.state.staging')
  if (state === 'pending-restart') {
    return pendingVersion
      ? t('updates.state.pendingRestartVersion', { version: pendingVersion })
      : t('updates.state.pendingRestart')
  }
  return null
}

// ---------------------------------------------------------------------------
// Framework card
// ---------------------------------------------------------------------------

function FrameworkCard({
  view,
  onCheck,
  onApply,
  checking,
  startError,
}: {
  readonly view: ServerUpdateView
  readonly onCheck: () => void
  readonly onApply: () => void
  readonly checking: boolean
  readonly startError: string | null
}) {
  const [armed, setArmed] = useState(false)
  const { t } = useT()
  const { status, lastApply, applyInFlight, lastCheckError } = view
  const progress = stateLabel(t, status.updateState, status.pendingVersion)
  const busy = applyInFlight || status.updateState === 'staging'
  const pendingRestart = status.updateState === 'pending-restart'

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-mono truncate">{status.packageName}</span>
          {status.updateAvailable && (
            <Badge variant="warning" className="text-[10px]">
              {t('updates.updateAvailable')}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onCheck}
            disabled={checking || busy}
          >
            {checking ? t('updates.checking') : t('updates.check')}
          </Button>
          {!pendingRestart && status.updateAvailable && (
            <Button
              type="button"
              variant={armed ? 'danger' : 'primary'}
              size="sm"
              onClick={() => {
                if (!armed) {
                  setArmed(true)
                  return
                }
                setArmed(false)
                onApply()
              }}
              disabled={busy}
            >
              <Download className="h-3 w-3" />
              {armed
                ? t('updates.confirmApply')
                : status.latestVersion
                  ? t('updates.applyTo', { version: status.latestVersion })
                  : t('updates.apply')}
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-0">
        <SettingRow label={t('updates.running')} valueClassName="font-mono">
          {status.runningVersion ?? '—'}
        </SettingRow>
        <SettingRow label={t('updates.published')} valueClassName="font-mono">
          {status.latestVersion ?? t('updates.notChecked')}
        </SettingRow>
        <SettingRow label={t('updates.loadedFrom')}>{bootModeLabel(t, status.bootMode)}</SettingRow>
      </div>

      {armed && !busy && <ErrorBox message={t('updates.restartWarning')} variant="warning" />}

      {busy && (
        <div className="flex items-center gap-1.5 text-[11px] text-warning">
          <RefreshCw className="h-3 w-3 animate-spin" />
          {progress ?? t('updates.state.working')}
        </div>
      )}
      {!busy && pendingRestart && progress && (
        <div className="flex items-center gap-1.5 text-[11px] text-warning">
          <RefreshCw className="h-3 w-3 animate-spin" />
          {progress}
        </div>
      )}

      {startError !== null && <ErrorBox message={startError} />}
      {lastApply !== null && !lastApply.accepted && <ErrorBox message={lastApply.message} />}
      {lastApply !== null && lastApply.accepted && <NoteLine text={lastApply.message} />}
      {lastCheckError !== null && (
        <ErrorBox message={t('updates.checkFailed', { error: lastCheckError })} />
      )}

      <NoteLine text={t('updates.npmNote')} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

/**
 * `locked` mirrors the dashboard's unlock screen: while the operator has not
 * unlocked, these routes 401 and polling them would just spin.
 */
export function UpdatesPanel({
  locked,
  onUnauthorized,
}: {
  readonly locked: boolean
  readonly onUnauthorized: () => void
}) {
  const { t } = useT()
  const [server, setServer] = useState<ServerUpdateResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  const onFailure = useCallback(
    (err: unknown): void => {
      if (err instanceof UnauthorizedError) {
        onUnauthorized()
        return
      }
      setLoadError(err instanceof Error ? err.message : translate('common.unknownError'))
    },
    [onUnauthorized],
  )

  const poll = useCallback(async (): Promise<void> => {
    try {
      setServer(await fetchJson<ServerUpdateResponse>('/api/agent/server-update'))
      setLoadError(null)
    } catch (err) {
      onFailure(err)
    }
  }, [onFailure])

  useEffect(() => {
    if (locked) return
    let active = true
    const run = () => {
      if (active) void poll()
    }
    run()
    const interval = setInterval(run, 5_000)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [locked, poll])

  const handleCheck = useCallback(async (): Promise<void> => {
    setChecking(true)
    try {
      await postJson('/api/agent/server-update/check', {})
      await poll()
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : translate('updates.checkRequestFailed'))
    } finally {
      setChecking(false)
    }
  }, [poll])

  const autoCheckedRef = useRef(false)
  useEffect(() => {
    if (locked || autoCheckedRef.current) return
    if (server === null || !server.available) return
    if (server.status.latestVersion !== null || server.status.updateState !== 'idle') return
    autoCheckedRef.current = true
    void handleCheck()
  }, [locked, server, handleCheck])

  const handleApply = useCallback(async (): Promise<void> => {
    setStartError(null)
    try {
      const res = await postJson<ServerUpdateStartResult>('/api/agent/server-update/apply', {})
      if (!res.started && res.message !== null) setStartError(res.message)
      await poll()
    } catch (err) {
      setStartError(err instanceof Error ? err.message : translate('updates.applyFailed'))
    }
  }, [poll])

  return (
    <SectionCard headingId="agent-updates" title={t('updates.title')} icon={Download}>
      <div className={`${SECTION_BODY} space-y-4`}>
        {loadError !== null && <ErrorBox message={t('updates.readFailed', { error: loadError })} />}

        {server === null && loadError === null && (
          <div className="text-[11px] text-foreground-subtle">{t('common.loading')}</div>
        )}
        {server !== null &&
          (server.available ? (
            <FrameworkCard
              view={server}
              onCheck={() => void handleCheck()}
              onApply={() => void handleApply()}
              checking={checking}
              startError={startError}
            />
          ) : (
            <NoteLine text={server.reason} />
          ))}
      </div>
    </SectionCard>
  )
}
