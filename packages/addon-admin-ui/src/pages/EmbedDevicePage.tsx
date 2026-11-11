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
 * Whether the session may act on THIS device is `auth.deviceAccess`: the hub's
 * own scope matcher, over the scopes it enforces, asked about this device id
 * (not the admin flag: a user can be allowed to command devices). A user who
 * may not gets the controls disabled with the reason; the hub also refuses
 * the command itself (`protectedProcedure`). A hub without that route answers
 * an error, and the card falls back to the admin flag.
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

/** `auth.deviceAccess`'s answer: what the caller may do on one device. */
export interface EmbedDeviceAccess {
  readonly view: boolean
  readonly command: boolean
}

/**
 * May the session command this device? The hub's answer when it gave one;
 * otherwise (a hub that predates the route, a failed read) only an admin.
 */
export function embedCanActuate(access: EmbedDeviceAccess | null, isAdmin: boolean): boolean {
  return access === null ? isAdmin : access.command
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
  const deviceId = parseEmbedDeviceId(params['deviceId'])
  // `auth.deviceAccess` is a CORE router method — no generated cap hook.
  const access = useQuery<EmbedDeviceAccess>({
    queryKey: ['auth', 'deviceAccess', deviceId] as const,
    queryFn: () => system.trpcClient.auth.deviceAccess.query({ deviceId: deviceId ?? 0 }),
    enabled: deviceId !== null,
    retry: false,
  })
  const requestedTheme = parseEmbedTheme(search.get('theme'))
  // The theme class lives on <html>: dialogs the card opens portal outside it.
  useEffect(() => {
    if (requestedTheme !== null) setMode(requestedTheme)
  }, [requestedTheme, setMode])
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
  if (access.status === 'pending') {
    return (
      <main className={`${theme} min-h-screen bg-background p-3`}>
        <Skeleton className="mx-auto h-72 w-full max-w-2xl" />
      </main>
    )
  }
  const canActuate = embedCanActuate(
    access.status === 'success' ? access.data : null,
    user?.isAdmin === true,
  )
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
