/**
 * Product release and server package, for the login footer and the sidebar.
 * The hub answers `GET /api/release-identity`. A hub that predates the route
 * keeps the addon version that was baked into this bundle.
 */
import { useEffect, useState, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { hubPath } from '../lib/mount'
import {
  describeRelease,
  parseReleaseIdentity,
  type ReleaseDescription,
} from '../lib/release-identity'

export interface ReleaseIdentityFooterProps {
  readonly placement: 'sidebar' | 'login'
  readonly compact?: boolean
}

interface ReleaseTranslator {
  (key: string, fallback: string, vars?: Readonly<Record<string, string>>): string
}

function textOf(described: ReleaseDescription, t: ReleaseTranslator): string | null {
  if (described.kind === 'both') {
    return t('releaseIdentity.both', '{{product}} · server {{server}}', {
      product: described.productLabel,
      server: described.serverVersion,
    })
  }
  if (described.kind === 'product') return described.productLabel
  if (described.kind === 'server') {
    return t('releaseIdentity.serverOnly', 'server {{version}}', {
      version: described.serverVersion,
    })
  }
  if (described.kind === 'fallback') {
    return t('releaseIdentity.fallback', 'v{{version}}', { version: described.version })
  }
  return null
}

export function ReleaseIdentityFooter({
  placement,
  compact = false,
}: ReleaseIdentityFooterProps): JSX.Element | null {
  const { t } = useTranslation()
  const [described, setDescribed] = useState<ReleaseDescription>({
    kind: 'fallback',
    version: __APP_VERSION__,
  })

  useEffect(() => {
    const controller = new AbortController()
    void fetch(hubPath('/api/release-identity'), { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return null
        const body: unknown = await res.json()
        return parseReleaseIdentity(body)
      })
      .then((pair) => {
        if (controller.signal.aborted || pair === null) return
        setDescribed(
          describeRelease({
            productVersion: pair.productVersion,
            serverVersion: pair.serverVersion,
            fallbackVersion: __APP_VERSION__,
          }),
        )
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        // An old hub has no route, and a navigation away aborts the fetch.
        // The fallback version stays. Anything else is still not a version
        // we should invent.
        if (err instanceof DOMException && err.name === 'AbortError') return
      })
    return () => controller.abort()
  }, [])

  const text = textOf(described, t)
  if (text === null) return null

  if (placement === 'login') {
    return <span data-testid="release-identity">{text}</span>
  }
  return (
    <div
      data-testid="release-identity"
      className={`pt-1 text-[10px] text-foreground-disabled select-none truncate ${compact ? 'text-center' : 'px-2'}`}
      title={text}
    >
      {text}
    </div>
  )
}
