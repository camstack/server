/**
 * Notifications → Settings — Alert Center knobs (storage and retention).
 *
 * The alert centre sends no notification of its own: a critical or error alert
 * reaches a phone only through a system-event rule (`alert-critical`,
 * `alert-error`, `alert-critical-resolved`). The form is the addon's own global
 * schema so the Integrations / System surfaces stay in sync.
 */
import { AddonGlobalSettingsForm, TEXT_HINT, useSystem } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'

const ALERT_CENTER_ADDON_ID = 'alert-center'

export function NotificationSettingsPage() {
  const { t } = useTranslation()
  const system = useSystem()

  return (
    <div className="space-y-3" data-testid="notification-settings">
      <p className={TEXT_HINT}>
        {t(
          'systemPage.notifications.settingsHint',
          'Alert storage and retention. Alerts are notified only through notification rules on the alert kinds.',
        )}
      </p>
      <AddonGlobalSettingsForm
        trpc={system.trpcClient}
        addonId={ALERT_CENTER_ADDON_ID}
        nodeId="hub"
        bare
      />
    </div>
  )
}
