/**
 * Events section of Library — Feed + Debug (`?section=`).
 *
 * Nested `SectionedPage` with `sectionsOnly` — Library owns the page chrome
 * and `?tab=`.
 */
import { Navigate, useSearchParams } from 'react-router-dom'
import { AdminSectionedPage } from '../components/AdminSectionedPage'

import { EventsDebugPage } from './EventsDebug'
import { EventsFeedPage } from './EventsFeed'
import { useTranslation } from 'react-i18next'

export function EventsPage() {
  const { t } = useTranslation()
  const [params] = useSearchParams()
  if (params.get('section') === 'retrain') {
    return <Navigate to="/addon/training" replace /> // hub-path-ok: react-router redirect
  }

  return (
    <AdminSectionedPage
      sectionsOnly
      paramName="section"
      defaultSection="feed"
      sectionsLabel="Events sections"
      sections={[
        { id: 'feed', label: t('events.feed', 'Feed'), content: <EventsFeedPage /> },
        { id: 'debug', label: t('events.debug', 'Debug'), content: <EventsDebugPage /> },
      ]}
    />
  )
}
