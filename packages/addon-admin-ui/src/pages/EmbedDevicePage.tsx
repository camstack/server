/**
 * `/embed/device/:deviceId` — ONE device's detail card (hero, history, actions)
 * with no admin chrome: the page a viewer WebView loads for a device.
 *
 * Auth is the admin's STORED session (`ProtectedRoute` in `App.tsx`); the
 * httpOnly cookie alone does not sign the page in. The viewer seeds that
 * session before the page boots — no token in the URL. The card is the same
 * `DeviceDetailModule` the device page mounts, so look and behaviour are the
 * admin's.
 *
 * Query: `?theme=light|dark` (default: the admin's theme), `?lang=en|it`
 * (default: the admin's language) and `?host=viewer` (the viewer's device
 * screen, whose header already names the device: the card drops its name).
 *
 * Whether the session may act is the signed-in user's own grant, from
 * `auth.me` — not the admin flag: a user can be allowed to command devices.
 * The hub enforces it per device on every call.
 */
import { ErrorBox, heroLang, Skeleton, useSystem, useThemeMode } from '@camstack/ui-library'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useAuth } from '../contexts/auth-context'
import { DeviceDetailModule, type DeviceModuleLocale } from '../modules/device-detail'

type EmbedTheme = 'light' | 'dark'

/** The device id of the path, or null when it is not a positive integer. */
export function parseEmbedDeviceId(raw: string | undefined): number | null {
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return null
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export function parseEmbedTheme(raw: string | null): EmbedTheme | null {
  return raw === 'light' || raw === 'dark' ? raw : null
}

export function parseEmbedLocale(raw: string | null): DeviceModuleLocale | null {
  return raw === 'en' || raw === 'it' ? raw : null
}

/** `?host=viewer`: the card is shown under the viewer's own device header. */
export function parseEmbedHost(raw: string | null): 'viewer' | null {
  return raw === 'viewer' ? raw : null
}

/** One reach of the session's resolved scope (`auth.me`): counts, never ids. */
interface EmbedDeviceReach {
  readonly all: boolean
  readonly deviceCount: number
}

/** The part of `auth.me` the card's permission is read from. */
export interface EmbedSession {
  readonly isAdmin: boolean
  readonly scope?: {
    readonly isAdmin: boolean
    readonly device: { readonly create: EmbedDeviceReach }
  }
}

/**
 * May this session command devices? An admin may; anyone else may when their
 * resolved scope reaches at least one device with `create` (the grant that runs
 * device actions). The hub reports reach as counts, so this cannot say "this
 * device": a user with create on some devices keeps the controls and the hub
 * refuses the devices outside their grant.
 */
export function embedCanActuate(session: EmbedSession | null): boolean {
  if (session === null) return false
  if (session.isAdmin || session.scope?.isAdmin === true) return true
  const create = session.scope?.device.create
  return create !== undefined && (create.all || create.deviceCount > 0)
}

export function EmbedDevicePage(): ReactNode {
  const { t, i18n } = useTranslation()
  const params = useParams()
  const [search] = useSearchParams()
  const navigate = useNavigate()
  const system = useSystem()
  const { user } = useAuth()
  const { resolvedMode, setMode } = useThemeMode()
  const queryClient = useQueryClient()
  // `auth.me` is a CORE router method — no generated cap hook.
  const me = useQuery<EmbedSession | null>({
    queryKey: ['auth', 'me', 'embed-device'] as const,
    queryFn: () => system.trpcClient.auth.me.query(),
  })
  const requestedTheme = parseEmbedTheme(search.get('theme'))
  // The theme class lives on <html>: dialogs the card opens portal outside it.
  useEffect(() => {
    if (requestedTheme !== null) setMode(requestedTheme)
  }, [requestedTheme, setMode])
  const deviceId = parseEmbedDeviceId(params['deviceId'])
  if (deviceId === null) {
    return (
      <div className="min-h-screen bg-background p-3">
        <ErrorBox message={t('embedDevice.invalidId', 'This link does not name a device.')} />
      </div>
    )
  }
  const theme = requestedTheme ?? resolvedMode
  const inViewer = parseEmbedHost(search.get('host')) === 'viewer'
  // Unanswered is not "may not": wait for the grant rather than draw a card
  // without controls and then grow them. A failed read falls back to the
  // session's admin flag; the hub still refuses what the user may not do.
  if (me.status === 'pending') {
    return (
      <main className={`${theme} min-h-screen bg-background p-3`}>
        <Skeleton className="mx-auto h-72 w-full max-w-2xl" />
      </main>
    )
  }
  const canActuate = me.status === 'success' ? embedCanActuate(me.data) : user?.isAdmin === true
  return (
    <main className={`${theme} min-h-screen bg-background text-foreground`}>
      <div className="mx-auto w-full max-w-2xl">
        <DeviceDetailModule
          deviceId={deviceId}
          trpcClient={system.trpcClient}
          queryClient={queryClient}
          theme={theme}
          locale={parseEmbedLocale(search.get('lang')) ?? heroLang(i18n.language)}
          canActuate={canActuate}
          showName={!inViewer}
          onOpenDevice={(id) => navigate(`/embed/device/${String(id)}?${search.toString()}`)}
        />
      </div>
    </main>
  )
}
