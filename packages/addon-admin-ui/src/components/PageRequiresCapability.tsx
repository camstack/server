/**
 * Disabling a page whose providing addon is absent — generically.
 *
 * A built-in page declares the capability it needs in `PAGE_REQUIRED_CAPABILITY`
 * (`lib/nav-items.ts`). Two consumers read that one declaration:
 *  - the sidebar entry, greyed by `NavItemCapabilityGate`;
 *  - the route, replaced by a not-installed state by `PageRequiresCapability`.
 *
 * Presence comes only from `useCapabilityPresence` (D315): `absent` means the
 * registry ANSWERED with no provider. `pending` is progress and `unknown` is a
 * failed check — neither is ever drawn as "not installed".
 */
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Puzzle } from 'lucide-react'
import { Button, EmptyState, ErrorBox, Skeleton } from '@camstack/ui-library'
import { useCapabilityPresence } from '../lib/capability-presence'
import { navChromeForPath, PAGE_REQUIRED_CAPABILITY } from '../lib/nav-items'

const ADDONS_PATH = '/system/addons'

export interface PageRequiresCapabilityProps {
  /** The page's route path, a key of `PAGE_REQUIRED_CAPABILITY`. */
  readonly path: string
  readonly children: ReactNode
}

/** Mounts `children` only once the page's providing capability is present. */
export function PageRequiresCapability({ path, children }: PageRequiresCapabilityProps) {
  const capability = PAGE_REQUIRED_CAPABILITY[path]
  if (capability === undefined) return <>{children}</>
  return (
    <PresenceGate path={path} capability={capability}>
      {children}
    </PresenceGate>
  )
}

interface PresenceGateProps extends PageRequiresCapabilityProps {
  readonly capability: string
}

function PresenceGate({ path, capability, children }: PresenceGateProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const presence = useCapabilityPresence(capability)
  if (presence === 'present') return <>{children}</>

  if (presence === 'pending') {
    return (
      <div className="flex flex-col gap-4 p-2 sm:p-4" data-testid="page-presence-pending">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-40" />
      </div>
    )
  }

  if (presence === 'unknown') {
    return (
      <div className="p-2 sm:p-4" data-testid="page-presence-unknown">
        <ErrorBox
          title={t('pageRequires.unknownTitle', 'Could not check whether this page is available')}
          message={t(
            'pageRequires.unknown',
            'The hub did not answer the capability check. Reload the page to try again.',
          )}
        />
      </div>
    )
  }

  const chrome = navChromeForPath(path, { t, isAdmin: true })
  return (
    <div className="p-2 sm:p-4" data-testid="page-not-installed">
      <EmptyState
        icon={chrome?.icon ?? Puzzle}
        title={t('pageRequires.absentTitle', '{{page}} is not installed', {
          page: chrome?.title ?? path,
        })}
        description={t(
          'pageRequires.absentDescription',
          'The addon that provides this page is not installed. Install it from System → Addons.',
        )}
        action={
          <Button variant="primary" onClick={() => navigate(ADDONS_PATH)}>
            {t('pageRequires.openAddons', 'Open Addons')}
          </Button>
        }
      />
    </div>
  )
}

export interface NavItemCapabilityGateProps {
  readonly capability: string
  /** `absent` is true ONLY for an answered absence. */
  readonly children: (absent: boolean) => ReactNode
}

/** Asks the registry for a nav entry's capability; pending/unknown stay enabled. */
export function NavItemCapabilityGate({ capability, children }: NavItemCapabilityGateProps) {
  const presence = useCapabilityPresence(capability)
  return <>{children(presence === 'absent')}</>
}
