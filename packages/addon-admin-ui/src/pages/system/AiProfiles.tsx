/**
 * AI — Profiles / Runtimes / Usage / Test under SectionedPage (OSD template).
 *
 * Sidebar chrome from `navChromeForPath`; section bodies are embedded, so the
 * page header carries what belongs to the ACTIVE section: its one-sentence
 * subtitle and its create action (Profiles → "Add profile", which opens the
 * editor through the URL the Profiles section already reads, `?new=1`).
 *
 * The whole page is the `llm` capability's surface, so it asks the registry
 * first (D315): not-yet-known renders a placeholder, never "not installed".
 */
import {
  Button,
  EmptyState,
  ErrorBox,
  Skeleton,
  useCapabilityPresence,
  useItemFormUrl,
} from '@camstack/ui-library'
import { Plus, Sparkles } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { AdminPage } from '../../components/AdminPage'
import { AdminSectionedPage } from '../../components/AdminSectionedPage'

import { navChromeForPath } from '../../lib/nav-items'
import { AiProfilesTabPage } from './AiProfilesTab'
import { AiRuntimesPage } from './AiRuntimes'
import { AiTestChatPage } from './AiTestChat'
import { AiUsagePage } from './AiUsage'

const LLM_CAPABILITY = 'llm'
const SECTION_IDS = ['profiles', 'runtimes', 'usage', 'test'] as const
type AiSectionId = (typeof SECTION_IDS)[number]
/** The editor's URL keys (`useItemFormUrl` defaults) — dropped on leaving Profiles. */
const PROFILE_EDITOR_PARAMS = ['new', 'edit'] as const

function isSectionId(value: string | null): value is AiSectionId {
  return SECTION_IDS.some((id) => id === value)
}

export function AiProfilesPage() {
  const { t } = useTranslation()
  const presence = useCapabilityPresence(LLM_CAPABILITY)
  const [searchParams] = useSearchParams()
  const { openNew } = useItemFormUrl()
  const chrome = navChromeForPath('/system/ai', { t, isAdmin: true }) ?? {
    icon: Sparkles,
    title: t('system.ai', 'AI'),
  }

  if (presence !== 'present') {
    return (
      <AdminPage icon={chrome.icon} title={chrome.title}>
        <AiPresenceState presence={presence} />
      </AdminPage>
    )
  }

  const rawTab = searchParams.get('tab')
  const active: AiSectionId = isSectionId(rawTab) ? rawTab : 'profiles'

  const subtitles: Readonly<Record<AiSectionId, string>> = {
    profiles: t(
      'ai.profilesSubtitle',
      'One row = one usable model endpoint. The defaults below decide who answers when a feature names no profile.',
    ),
    runtimes: t(
      'ai.runtimesSubtitle',
      'Nodes advertising the llm-runtime capability: what each has loaded, what it is downloading, and how much model data sits on its disk.',
    ),
    usage: t(
      'ai.usageSubtitle',
      'Server-side rollup per day, consumer and profile — never raw call rows. Errors are counted, so a profile that always fails is visible here before a feature reports it.',
    ),
    test: t(
      'ai.testSubtitle',
      'A throwaway conversation with one profile. Attach a live camera snapshot or a recent track to check the model can actually read a picture. Nothing is saved — only the usage row.',
    ),
  }

  const actions: ReactNode =
    active === 'profiles' ? (
      <Button size="sm" type="button" data-testid="ai-add-profile" onClick={openNew}>
        <Plus className="h-3.5 w-3.5" />
        {t('ai.addProfile', 'Add profile')}
      </Button>
    ) : undefined

  return (
    <AdminSectionedPage
      icon={chrome.icon}
      title={chrome.title}
      subtitle={subtitles[active]}
      actions={actions}
      defaultSection="profiles"
      sectionsLabel={`${chrome.title} sections`}
      sections={[
        {
          id: 'profiles',
          label: t('ai.tabProfiles', 'Profiles'),
          content: <AiProfilesTabPage />,
          ownedParams: PROFILE_EDITOR_PARAMS,
        },
        {
          id: 'runtimes',
          label: t('ai.tabRuntimes', 'Runtimes'),
          content: <AiRuntimesPage />,
        },
        {
          id: 'usage',
          label: t('ai.tabUsage', 'Usage'),
          content: <AiUsagePage />,
        },
        {
          id: 'test',
          label: t('ai.tabTest', 'Test'),
          content: <AiTestChatPage />,
        },
      ]}
    />
  )
}

interface AiPresenceStateProps {
  readonly presence: 'pending' | 'absent' | 'unknown'
}

/** The three answers that are not "present" — each says something different. */
function AiPresenceState({ presence }: AiPresenceStateProps) {
  const { t } = useTranslation()
  if (presence === 'pending') {
    return (
      <div className="space-y-3" data-testid="ai-presence-pending">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }
  if (presence === 'unknown') {
    return (
      <ErrorBox
        title={t('ai.presenceUnknownTitle', 'Could not check whether AI is installed')}
        message={t(
          'ai.presenceUnknown',
          'The hub did not answer the capability check. Reload the page to try again.',
        )}
      />
    )
  }
  return (
    <EmptyState
      icon={Sparkles}
      title={t('ai.absentTitle', 'AI is not installed')}
      description={t(
        'ai.absentDescription',
        'Install the AI addon from System → Addons to add model profiles.',
      )}
    />
  )
}

export default AiProfilesPage
