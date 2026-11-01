/**
 * `/approve` — where an operator approves a terminal sign-in (D989). The code
 * is typed here; nothing in the URL pre-fills it. An approval ends on the
 * existing completion page (`/sso-complete`, action `cli-login`).
 */
import { oauthLandingUrl } from '@camstack/types'
import { Button, useThemeMode } from '@camstack/ui-library'
import { useState, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { CliLoginApproval } from '../components/auth/CliLoginApproval'
import { hubPath } from '../lib/mount'

export function ApprovePage(): JSX.Element {
  const { t } = useTranslation()
  const theme = useThemeMode()
  const navigate = useNavigate()
  const [denied, setDenied] = useState(false)

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <img
            src={
              theme?.resolvedMode === 'light'
                ? hubPath('/brand/logo-horizontal-light.svg')
                : hubPath('/brand/logo-horizontal-dark.svg')
            }
            alt={t('cliLogin.brand', 'CamStack')}
            className="h-12"
          />
        </div>
        <div className="rounded-xl border border-border bg-surface p-6 shadow-xl shadow-black/10">
          {denied ? (
            <div className="space-y-3 text-center" data-testid="cli-login-denied">
              <p className="text-sm text-foreground">
                {t('cliLogin.deniedBody', 'The sign-in was denied. The terminal stays signed out.')}
              </p>
              <Button type="button" variant="ghost" onClick={() => void navigate('/')}>
                {t('cliLogin.back', 'Back to CamStack')}
              </Button>
            </div>
          ) : (
            <CliLoginApproval
              onApproved={() =>
                window.location.assign(
                  hubPath(oauthLandingUrl(null, { status: 'success', action: 'cli-login' })),
                )
              }
              onDenied={() => setDenied(true)}
            />
          )}
        </div>
      </div>
    </div>
  )
}
