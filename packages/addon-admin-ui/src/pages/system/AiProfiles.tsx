/**
 * AI — Profiles / Runtimes / Usage / Test under SectionedPage (OSD template).
 *
 * Sidebar chrome from `navChromeForPath`; section bodies are embedded, so the
 * page header carries what belongs to the ACTIVE section: its one-sentence
 * subtitle; the Profiles section is the shared instances table, which carries
 * its own "Add profile" action and reads the editor from `?instance=` / `?instance-new=`.
 *
 * The whole page is the `llm` capability's surface, so it asks the registry
 * first (D315): not-yet-known renders a placeholder, never "not installed".
 */
import type { DataColumn } from '@camstack/ui-library'
import {
  Badge,
  EmptyState,
  ErrorBox,
  Skeleton,
  STACK_GAP,
  useCapabilityPresence,
  useInstancesOfCap,
} from '@camstack/ui-library'
import type { LinkableInstance } from '@camstack/ui-library'
import { Sparkles } from 'lucide-react'
import { useMemo } from 'react'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { AdminPage } from '../../components/AdminPage'
import { AdminSectionedPage } from '../../components/AdminSectionedPage'

import { navChromeForPath } from '../../lib/nav-items'
import { InstancesTable } from '../../components/instances/InstancesTable'
import type { PanelRow } from '../../components/instances/instances-model'
import { profileModel, profileNode, profileSupportsVision } from './ai-page.helpers'
import { AiDefaultsCard } from './AiDefaultsCard'
import { AiProfileLead } from './AiProfileLead'
import { AiRuntimesPage } from './AiRuntimes'
import { AiTestChatPage } from './AiTestChat'
import { AiUsagePage } from './AiUsage'

const LLM_CAPABILITY = 'llm'
const SECTION_IDS = ['profiles', 'runtimes', 'usage', 'test'] as const
type AiSectionId = (typeof SECTION_IDS)[number]
/** The instances table's URL keys — dropped on leaving Profiles. */
const PROFILE_EDITOR_PARAMS = ['instance', 'instance-new'] as const

function isSectionId(value: string | null): value is AiSectionId {
  return SECTION_IDS.some((id) => id === value)
}

export function AiProfilesPage() {
  const { t } = useTranslation()
  const presence = useCapabilityPresence(LLM_CAPABILITY)
  const [searchParams] = useSearchParams()
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

  return (
    <AdminSectionedPage
      icon={chrome.icon}
      title={chrome.title}
      subtitle={subtitles[active]}
      defaultSection="profiles"
      sectionsLabel={`${chrome.title} sections`}
      sections={[
        {
          id: 'profiles',
          label: t('ai.tabProfiles', 'Profiles'),
          content: <AiProfilesSection />,
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

function facts<T>(
  row: PanelRow,
  byId: ReadonlyMap<string, LinkableInstance>,
  read: (p: LinkableInstance) => T,
): T | undefined {
  const profile = row.kind === 'instance' ? byId.get(row.id) : undefined
  return profile === undefined ? undefined : read(profile)
}

/** The Model / Vision / Node columns: the facts that tell two profiles apart at a glance. */
function profileColumns(
  byId: ReadonlyMap<string, LinkableInstance>,
  t: (key: string, fallback: string) => string,
): readonly DataColumn<PanelRow>[] {
  const modelOf = (row: PanelRow): string => facts(row, byId, profileModel) ?? ''
  const visionOf = (row: PanelRow): boolean => facts(row, byId, profileSupportsVision) ?? false
  const nodeOf = (row: PanelRow): string => facts(row, byId, profileNode) ?? ''
  return [
    {
      key: 'model',
      header: t('ai.colModel', 'Model'),
      sortValue: modelOf,
      render: (row) => (
        <span className="font-mono text-xs text-foreground-muted">{modelOf(row) || '—'}</span>
      ),
    },
    {
      key: 'vision',
      header: t('ai.colVision', 'Vision'),
      sortValue: (row) => (visionOf(row) ? 1 : 0),
      render: (row) =>
        visionOf(row) ? <Badge variant="info">{t('ai.vision', 'vision')}</Badge> : null,
    },
    {
      key: 'node',
      header: t('ai.colNode', 'Node'),
      sortValue: nodeOf,
      render: (row) => <span className="text-xs text-foreground-muted">{nodeOf(row) || '—'}</span>,
    },
  ]
}

function AiProfilesSection(): ReactElement {
  const { t } = useTranslation()
  const profiles = useInstancesOfCap({ functionCap: LLM_CAPABILITY })
  const byId = useMemo(
    () => new Map((profiles.data ?? []).map((p) => [p.id, p] as const)),
    [profiles.data],
  )
  const columns = useMemo(() => profileColumns(byId, t), [byId, t])
  return (
    <div className={STACK_GAP}>
      <AiDefaultsCard />
      <InstancesTable
        functionCap={LLM_CAPABILITY}
        icon={Sparkles}
        title={t('ai.profilesList', 'Profiles')}
        subtitle={t(
          'ai.profilesTableSubtitle',
          'Each profile is one model endpoint; switch one off to keep it without using it.',
        )}
        emptyTitle={t('ai.noProfilesTitle', 'No AI profiles yet')}
        emptyDescription={t(
          'ai.noProfilesDescription',
          'Add a profile to give features a model to talk to.',
        )}
        addLabel={t('ai.addProfile', 'Add profile')}
        extraColumns={columns}
        lead={(row) => <AiProfileLead row={row} />}
      />
    </div>
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
