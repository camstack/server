/** The join card of a mesh provider: Joined badge, peer count, Connect / Disconnect / Log out. */
import { useCallback, useState, type ReactElement } from 'react'
import { LogIn, LogOut, Loader2, X, ShieldOff } from 'lucide-react'
import {
  Button,
  Badge,
  useMeshNetworkStartLogin,
  useMeshNetworkLeave,
  useMeshNetworkLogout,
  useSystem,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { MeshStatusSchema } from '@camstack/types'
import { useTranslation } from 'react-i18next'
import { STATUS_BADGE_CLASS } from '../integration-hub/addon-controls'
import { useMeshStatus } from './use-mesh-status'

export function MeshJoinCard({ addonId }: { readonly addonId: string }): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ProviderStatusBadges addonId={addonId} />
      <ProviderPrimaryAction addonId={addonId} />
    </div>
  )
}

// ── Status badges (Joined / peer count) ─────────────────────────────

function ProviderStatusBadges({ addonId }: { readonly addonId: string }): ReactElement {
  const { t } = useTranslation()
  const { status } = useMeshStatus(addonId)
  return (
    <>
      <Badge variant={status.joined ? 'success' : 'default'} className={STATUS_BADGE_CLASS}>
        {status.joined
          ? t('system.meshNetworks.joined', 'Joined')
          : t('system.meshNetworks.notJoined', 'Not joined')}
      </Badge>
      {status.joined && (
        <Badge className={STATUS_BADGE_CLASS}>
          {t('common.peers', { count: status.peerCount })}
        </Badge>
      )}
    </>
  )
}

// ── Primary action (Connect / Disconnect / Logout) ──────────────────

/**
 * The page-specific PRIMARY lifecycle action. The provider's live
 * `joined` state drives what's visible:
 *   • joined         → Disconnect + Logout
 *   • not joined     → Connect + Logout (lets the operator wipe cached
 *                      credentials before pasting an auth key)
 *   • connecting     → Cancel (poll abort)
 *
 * Connect drives the browser-redirect login flow: `meshNetwork.startLogin`
 * opens the provider's auth URL in a new tab, then we poll
 * `meshNetwork.getStatus({ addonId })` until the provider reports
 * `joined: true`. (Restart lives in the common surface.)
 */
function ProviderPrimaryAction({ addonId }: { readonly addonId: string }): ReactElement {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [connecting, setConnecting] = useState<boolean>(false)
  const [pollAbort, setPollAbort] = useState<{ cancelled: boolean } | null>(null)
  const system = useSystem()
  const { status } = useMeshStatus(addonId)

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: [['meshNetwork']] })
  }, [queryClient])

  const startLoginMutation = useMeshNetworkStartLogin()
  const leaveMutation = useMeshNetworkLeave({ onSuccess: invalidate })
  const logoutMutation = useMeshNetworkLogout({ onSuccess: invalidate })

  const startConnect = useCallback(async () => {
    setConnecting(true)
    const abort = { cancelled: false }
    setPollAbort(abort)
    try {
      const result = await startLoginMutation.mutateAsync({ addonId })
      if (abort.cancelled) return
      // Empty loginUrl = silent re-login from cached daemon credentials
      // (the provider exited 0 before printing a URL). Skip the popup
      // and let the status poll below detect the join.
      if (result.loginUrl) {
        window.open(result.loginUrl, '_blank', 'noopener,noreferrer')
      }
      const startedAt = Date.now()
      const MAX_POLL_MS = 10 * 60_000
      while (!abort.cancelled) {
        await sleep(2_000)
        if (abort.cancelled) break
        const snap = await system.trpcClient.meshNetwork.getStatus
          .query({ addonId })
          .catch(() => null)
        const parsed = snap ? MeshStatusSchema.safeParse(snap) : null
        if (parsed?.success && parsed.data.joined) {
          invalidate()
          break
        }
        if (Date.now() - startedAt > MAX_POLL_MS) {
          // Surface failures via the status error banner — the next
          // status poll picks up the provider's own state.
          break
        }
      }
    } finally {
      setConnecting(false)
      setPollAbort(null)
    }
  }, [addonId, invalidate, startLoginMutation, system])

  const cancelConnect = useCallback(() => {
    if (pollAbort) pollAbort.cancelled = true
    setConnecting(false)
    setPollAbort(null)
  }, [pollAbort])

  return (
    <>
      {status.joined ? (
        <>
          <Button
            size="sm"
            variant="secondary"
            disabled={leaveMutation.isPending}
            onClick={() => leaveMutation.mutate({ addonId })}
          >
            {leaveMutation.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <LogOut className="h-3 w-3" />
            )}
            {t('system.meshNetworks.disconnect', 'Disconnect')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={logoutMutation.isPending}
            onClick={() => logoutMutation.mutate({ addonId })}
          >
            {logoutMutation.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <ShieldOff className="h-3 w-3" />
            )}
            {t('system.meshNetworks.logOut', 'Log out')}
          </Button>
        </>
      ) : connecting ? (
        <Button size="sm" variant="ghost" onClick={cancelConnect}>
          <X className="h-3 w-3 mr-1" /> {t('common.cancel')}
        </Button>
      ) : (
        <>
          <Button size="sm" variant="primary" onClick={() => void startConnect()}>
            <LogIn className="h-3 w-3" />
            {t('system.meshNetworks.connect', 'Connect')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={logoutMutation.isPending}
            onClick={() => logoutMutation.mutate({ addonId })}
          >
            {logoutMutation.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <ShieldOff className="h-3 w-3" />
            )}
            {t('system.meshNetworks.logOut', 'Log out')}
          </Button>
        </>
      )}
    </>
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
