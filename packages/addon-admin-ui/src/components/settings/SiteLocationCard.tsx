/**
 * Site location — the installation's coordinates, on the hub-wide Settings page.
 *
 * This is deliberately NOT a declarative `ConfigUISchema` section like
 * everything else on this page. Two numbers would fit one, but the thing that
 * makes the setting honest does not: the operator has to be able to see whether
 * the value in the box is theirs or a guess the hub made from its public IP. A
 * `number` field cannot say that, and an operator who cannot tell the two apart
 * will eventually trust the guess.
 *
 * So: a provenance badge, a Detect button (the ONLY retry path — nothing
 * re-derives on a timer), and a Clear that leaves the derivation spent rather
 * than re-arming it.
 */

import {
  Badge,
  Button,
  Card,
  Input,
  useSystemDetectSiteLocation,
  useSystemGetSiteLocation,
  useSystemSetSiteLocation,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { MapPin, RefreshCw } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

/** tRPC cache key for the `system` router. The double array is not a typo. */
const SYSTEM_KEY = [['system']]

function formatCoordinate(value: number): string {
  return value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
}

export function SiteLocationCard() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const query = useSystemGetSiteLocation()
  const setLocation = useSystemSetSiteLocation()
  const detect = useSystemDetectSiteLocation()

  const [latitude, setLatitude] = useState('')
  const [longitude, setLongitude] = useState('')
  const [error, setError] = useState<string | null>(null)

  const location = query.data?.location ?? null

  // Re-seed the inputs whenever the stored value changes — including after a
  // detect, so the operator sees what landed rather than an empty box next to a
  // "derived" badge.
  useEffect(() => {
    setLatitude(location === null ? '' : formatCoordinate(location.latitude))
    setLongitude(location === null ? '' : formatCoordinate(location.longitude))
  }, [location])

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: SYSTEM_KEY })
  }

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    const lat = Number(latitude)
    const lng = Number(longitude)
    if (latitude.trim() === '' || longitude.trim() === '') {
      setError('Enter both a latitude and a longitude, or press Clear.')
      return
    }
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      setError('Latitude must be between -90 and 90 decimal degrees.')
      return
    }
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
      setError('Longitude must be between -180 and 180 decimal degrees.')
      return
    }
    setError(null)
    await setLocation.mutateAsync({ latitude: lat, longitude: lng })
    await invalidate()
  }

  const onClear = async () => {
    setError(null)
    await setLocation.mutateAsync(null)
    await invalidate()
  }

  const onDetect = async () => {
    setError(null)
    await detect.mutateAsync()
    await invalidate()
  }

  const busy = setLocation.isPending || detect.isPending || query.isLoading

  return (
    <Card className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <MapPin className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
          <div>
            {/* Heading only. The paragraph that used to explain what the
                coordinates are FOR (sunrise/sunset for scene monitoring, the
                coarse UTC fallback when unset) was removed on the operator's
                request — it was long enough to bury the control. The behaviour
                it described is unchanged and documented in
                `docs/architecture/post-analysis.md`. */}
            <h3 className="text-sm font-medium">
              {t('settings.siteLocationCard.siteLocation', 'Site location')}
            </h3>
          </div>
        </div>
        {location !== null ? (
          <Badge variant={location.source === 'operator-set' ? 'success' : 'info'}>
            {location.source === 'operator-set'
              ? t('settings.siteLocationCard.setByYou', 'Set by you')
              : t('settings.siteLocationCard.derivedFromIp', 'Derived from IP')}
          </Badge>
        ) : (
          <Badge variant="warning">
            {t('settings.siteLocationCard.notConfigured', 'Not configured')}
          </Badge>
        )}
      </div>

      {location?.label !== undefined && location.label !== '' ? (
        <p className="text-xs text-muted-foreground">
          {t('settings.siteLocationCard.detectedNear', { place: location.label })}
        </p>
      ) : null}

      {location === null && query.data?.derivationAttemptedAt !== null ? (
        <p className="text-xs text-warning">
          {t(
            'settings.siteLocationCard.automaticDetectionFromThePublic',
            'Automatic detection from the public IP did not succeed',
          )}
          {query.data?.derivationError !== null && query.data?.derivationError !== undefined
            ? `: ${query.data.derivationError}`
            : '.'}{' '}
          {t(
            'settings.siteLocationCard.itIsNotRetriedOn',
            'It is not retried on its own — enter the coordinates, or press Detect.',
          )}
        </p>
      ) : null}

      <form className="flex flex-wrap items-end gap-3" onSubmit={onSubmit}>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">
            {t('settings.siteLocationCard.latitude', 'Latitude')}
          </span>
          <Input
            className="w-40"
            value={latitude}
            inputMode="decimal"
            placeholder="40.851800"
            onChange={(e) => setLatitude(e.target.value)}
            aria-label={t('settings.siteLocationCard.latitude', 'Latitude')}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">
            {t('settings.siteLocationCard.longitude', 'Longitude')}
          </span>
          <Input
            className="w-40"
            value={longitude}
            inputMode="decimal"
            placeholder="14.268100"
            onChange={(e) => setLongitude(e.target.value)}
            aria-label={t('settings.siteLocationCard.longitude', 'Longitude')}
          />
        </label>
        <Button type="submit" disabled={busy}>
          {t('common.save', 'Save')}
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onDetect}>
          <RefreshCw className="h-3.5 w-3.5 mr-1" />
          {t('settings.siteLocationCard.detectFromIp', 'Detect from IP')}
        </Button>
        {location !== null ? (
          <Button type="button" variant="ghost" disabled={busy} onClick={onClear}>
            {t('settings.siteLocationCard.clear', 'Clear')}
          </Button>
        ) : null}
      </form>

      {error !== null ? <p className="text-xs text-danger">{error}</p> : null}
      <p className="text-xs text-muted-foreground">
        {t(
          'settings.siteLocationCard.wgs84DecimalDegreesDetectAsks',
          'WGS84 decimal degrees. Detect asks a public geo-IP service once and will not overwrite a value you typed — clear it first.',
        )}
      </p>
    </Card>
  )
}
