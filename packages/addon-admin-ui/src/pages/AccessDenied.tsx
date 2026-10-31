import { useNavigate } from 'react-router-dom'
import { ShieldX } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@camstack/ui-library'

/**
 * Rendered inside `AppLayout` (sidebar + topbar stay visible) so users
 * landing here from a protected route can still navigate to pages they
 * DO have access to. The page is intentionally a small centred card —
 * `<main>` provides the bounding box, this component never takes the
 * full viewport.
 */
export function AccessDeniedPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  return (
    <div className="flex flex-col items-center justify-center text-foreground py-16 px-4">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-danger/10 mb-4">
        <ShieldX className="h-8 w-8 text-danger" />
      </div>
      <h1 className="text-xl font-bold">{t('accessDenied.accessDenied', 'Access Denied')}</h1>
      <p className="mt-2 text-sm text-foreground-subtle">
        {t('accessDenied.youDonTHavePermission', "You don't have permission to access this page.")}
      </p>
      <Button
        variant="unstyled"
        onClick={() => navigate('/devices')}
        className="mt-6 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground shadow-md shadow-primary/20 hover:shadow-lg transition-all"
      >
        {t('accessDenied.goToDevices', 'Go to Devices')}
      </Button>
    </div>
  )
}
