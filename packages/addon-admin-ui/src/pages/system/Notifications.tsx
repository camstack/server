/**
 * Notifications — Targets / Rules / Sequences / Simulate / History / Alarm /
 * Texts / Settings.
 *
 * Shell is library `SectionedPage` (OSD template). Add / New live on the page
 * header (AdminPage embedded drops actions). Rules → Simulate handoff stays
 * here (owns tab coordination).
 */
import type { NcRule } from '@camstack/types'
import { Button, useUrlQueryParam } from '@camstack/ui-library'
import { Bell, Plus } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { AdminSectionedPage } from '../../components/AdminSectionedPage'

import { navChromeForPath } from '../../lib/nav-items'
import { NotificationAlarmPage } from './NotificationAlarm'
import { NotificationHistoryPage } from './NotificationHistory'
import { NotificationRulesPage } from './NotificationRules'
import { NotificationSequencesPage, SEQUENCES_TAB_OWNED_PARAMS } from './NotificationSequences'
import { NotificationSettingsPage } from './NotificationSettings'
import { NotificationSimulatePage } from './NotificationSimulate'
import { NotificationTargetsPage } from './NotificationTargets'
import { NotificationTextsPage } from './NotificationTexts'
import {
  HISTORY_TAB_ID,
  HISTORY_TAB_OWNED_PARAMS,
  withHistoryTabForRule,
} from './notification-history.helpers'
import { TARGETS_TAB_OWNED_PARAMS } from './notification-targets-url'
import {
  type CreateRuleType,
  isProducerAreaKey,
  parseRulesArea,
  producerAreaOf,
  type RulesAreaKey,
} from './notification-rules-area'
import { NC_RULE_SECTIONS } from './rule-form-parsers'
import { parkSimulatePrefill, prefillForRule } from './notification-simulate.helpers'
import i18n from '../../i18n/index'

const SIMULATE_TAB_ID = 'simulate'
const RULES_TAB_ID = 'rules'
const TABS_WITH_CREATE = new Set(['targets', RULES_TAB_ID, 'sequences'])

function producerCreateType(area: RulesAreaKey): CreateRuleType | null {
  if (area === 'summaries') return 'summary'
  if (area === 'timelapses') return 'timelapse'
  if (area === 'calendar-events') return 'calendar-events'
  return null
}

/** Header create for Rules — All opens the type picker via pulse; typed sections create directly. */
function rulesHeaderActions(
  area: RulesAreaKey,
  onPickType: () => void,
  onCreateType: (type: CreateRuleType) => void,
): ReactNode {
  if (area === 'mixed') return undefined

  if (area === 'all') {
    return (
      <Button size="sm" type="button" data-testid="rules-new-menu" onClick={onPickType}>
        <Plus className="h-3.5 w-3.5" />
        {i18n.t('systemPage.notifications.newRule', 'New rule')}
      </Button>
    )
  }

  if (isProducerAreaKey(area)) {
    const producer = producerAreaOf(area)
    const type = producerCreateType(area)
    if (type === null) return undefined
    return (
      <Button
        size="sm"
        type="button"
        onClick={() => onCreateType(type)}
        data-testid={
          area === 'summaries'
            ? 'summary-new'
            : area === 'timelapses'
              ? 'timelapse-new'
              : 'calendar-events-new'
        }
      >
        <Plus className="h-3.5 w-3.5" />
        {producer.newLabel}
      </Button>
    )
  }

  const section = NC_RULE_SECTIONS.find((s) => s.key === area)
  if (section === undefined || !section.creatable) return undefined
  return (
    <Button
      size="sm"
      type="button"
      onClick={() => onCreateType(area as CreateRuleType)}
      data-testid={`rules-new-${area}`}
    >
      <Plus className="h-3.5 w-3.5" />
      {section.newRuleLabel}
    </Button>
  )
}

export function NotificationsPage() {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const [createRequested, setCreateRequested] = useState(false)
  const [rulesCreateType, setRulesCreateType] = useState<CreateRuleType | null>(null)

  useEffect(() => {
    const tab = searchParams.get('tab')
    if (tab === null || !isProducerAreaKey(tab)) return
    const next = new URLSearchParams(searchParams)
    next.set('tab', RULES_TAB_ID)
    next.set('section', tab)
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  const tab = searchParams.get('tab') ?? 'targets'
  // Same writer as Rules area pills (`useUrlQueryParam`) — not react-router
  // `searchParams`, which stays stale when pills replaceState the section.
  const [sectionParam] = useUrlQueryParam('section')
  const rulesArea: RulesAreaKey = parseRulesArea(sectionParam) ?? 'all'

  const simulateRule = (rule: NcRule): void => {
    parkSimulatePrefill(prefillForRule(rule))
    const next = new URLSearchParams(searchParams)
    next.set('tab', SIMULATE_TAB_ID)
    setSearchParams(next, { replace: true })
  }

  const openRuleHistory = (rule: NcRule): void => {
    setSearchParams(withHistoryTabForRule(searchParams, rule.id), { replace: true })
  }

  const chrome = navChromeForPath('/system/notifications', { t, isAdmin: true }) ?? {
    icon: Bell,
    title: t('system.notifications', 'Notifications'),
  }

  const clearCreate = (): void => setCreateRequested(false)

  const headerActions: ReactNode = (() => {
    if (tab === 'targets') {
      return (
        <Button
          size="sm"
          type="button"
          data-testid="notifications-add-target"
          onClick={() => setCreateRequested(true)}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('systemPage.notifications.addTarget', 'Add target')}
        </Button>
      )
    }
    if (tab === 'sequences') {
      return (
        <Button
          size="sm"
          type="button"
          data-testid="notifications-add-sequence"
          onClick={() => setCreateRequested(true)}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('systemPage.notifications.newSequence', 'New sequence')}
        </Button>
      )
    }
    if (tab === RULES_TAB_ID) {
      return rulesHeaderActions(
        rulesArea,
        () => setCreateRequested(true),
        (type) => setRulesCreateType(type),
      )
    }
    return undefined
  })()

  // Drop a stale create pulse when leaving a creatable tab.
  useEffect(() => {
    if (!TABS_WITH_CREATE.has(tab)) {
      setCreateRequested(false)
      setRulesCreateType(null)
    }
  }, [tab])

  return (
    <AdminSectionedPage
      icon={chrome.icon}
      title={chrome.title}
      defaultSection="targets"
      sectionsLabel={`${chrome.title} sections`}
      actions={headerActions}
      sections={[
        {
          id: 'targets',
          label: t('systemPage.notifications.targets', 'Targets'),
          content: (
            <NotificationTargetsPage
              headerOwnsCreate
              createRequested={tab === 'targets' && createRequested}
              onCreateConsumed={clearCreate}
            />
          ),
          ownedParams: TARGETS_TAB_OWNED_PARAMS,
        },
        {
          id: RULES_TAB_ID,
          label: t('systemPage.notifications.rules', 'Rules'),
          content: (
            <NotificationRulesPage
              onSimulateRule={simulateRule}
              onOpenHistory={openRuleHistory}
              headerOwnsCreate
              createRequested={tab === RULES_TAB_ID && createRequested}
              onCreateConsumed={clearCreate}
              createTypeRequested={tab === RULES_TAB_ID ? rulesCreateType : null}
              onCreateTypeConsumed={() => setRulesCreateType(null)}
            />
          ),
          ownedParams: ['section', 'rule', 'editTab'],
        },
        {
          id: 'sequences',
          label: t('systemPage.notifications.sequences', 'Sequences'),
          content: (
            <NotificationSequencesPage
              headerOwnsCreate
              createRequested={tab === 'sequences' && createRequested}
              onCreateConsumed={clearCreate}
            />
          ),
          ownedParams: SEQUENCES_TAB_OWNED_PARAMS,
        },
        {
          id: SIMULATE_TAB_ID,
          label: t('systemPage.notifications.simulate', 'Simulate'),
          content: <NotificationSimulatePage />,
        },
        {
          id: HISTORY_TAB_ID,
          label: t('systemPage.notifications.history', 'History'),
          content: <NotificationHistoryPage />,
          ownedParams: HISTORY_TAB_OWNED_PARAMS,
        },
        {
          id: 'alarm',
          label: t('systemPage.notifications.alarm', 'Alarm'),
          content: <NotificationAlarmPage />,
        },
        {
          id: 'texts',
          label: t('systemPage.notifications.texts', 'Texts'),
          content: <NotificationTextsPage />,
        },
        {
          id: 'settings',
          label: t('systemPage.notifications.settings', 'Settings'),
          content: <NotificationSettingsPage />,
        },
      ]}
    />
  )
}

export default NotificationsPage
