/**
 * `/embed/device/:deviceId` — ONE device's detail card (hero, history, actions)
 * with no admin chrome: the page a viewer WebView loads for a device.
 *
 * Auth is the existing admin session (`ProtectedRoute` in `App.tsx`: the
 * httpOnly cookie the WebView already carries, or the stored session) — no
 * token in the URL. The card is the same `DeviceDetailModule` the device page
 * mounts, so look and behaviour are the admin's.
 *
 * Query: `?theme=light|dark` (default: the admin's theme) and `?lang=en|it`
 * (default: the admin's language). Whether the session may act is the session's
 * own admin flag, as on the device page.
 */
import { ErrorBox, heroLang, useSystem, useThemeMode } from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
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

export function EmbedDevicePage(): ReactNode {
  const { t, i18n } = useTranslation()
  const params = useParams()
  const [search] = useSearchParams()
  const navigate = useNavigate()
  const system = useSystem()
  const { user } = useAuth()
  const { resolvedMode, setMode } = useThemeMode()
  const queryClient = useQueryClient()
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
  return (
    <main className={`${theme} min-h-screen bg-background text-foreground`}>
      <DeviceDetailModule
        deviceId={deviceId}
        trpcClient={system.trpcClient}
        queryClient={queryClient}
        theme={theme}
        locale={parseEmbedLocale(search.get('lang')) ?? heroLang(i18n.language)}
        canActuate={user?.isAdmin === true}
        onOpenDevice={(id) => navigate(`/embed/device/${String(id)}?${search.toString()}`)}
      />
    </main>
  )
}
