/**
 * Cluster → Settings — the cluster-wide pipeline settings, one titled card per
 * subject (`cluster-settings-sections.ts`): faces & recognition, semantic
 * search, the enrichment crop, full-resolution crops, runner defaults and
 * failover. Full width, like the other cluster tabs.
 *
 * The orchestrator's `cluster` section (the role pickers) renders in Roles &
 * nodes; its `load` section (session placement, min fps, node stress handling,
 * low-fps window) is the "Load balancer" card here and nowhere else. Every card
 * writes the owning addon's own store; nothing here keeps a copy.
 */
import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Cpu, Crop, Layers, Scale, Scan, ShieldAlert, Sparkles } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { SECTION_BODY, SectionCard, TEXT_HINT } from '@camstack/ui-library'
import { NodeAddonsSettingsPanel } from '../../settings/NodeAddonsSettingsPanel'
import { CLUSTER_SECTION_PARAM } from '../pipeline-links'
import {
  CLUSTER_SETTINGS_SECTIONS,
  type ClusterSettingsSection,
  LEGACY_SECTION_ALIASES,
  LOAD_SETTINGS_SECTION_ID,
} from './cluster-settings-sections'
import { useTranslation } from 'react-i18next'

interface ClusterSettingsTabProps {
  readonly refreshToken: number
}

/** How long a linked-to section stays highlighted after it is scrolled into view. */
const SECTION_HIGHLIGHT_MS = 2500

const SECTION_ICONS: Readonly<Record<string, LucideIcon>> = {
  faces: Scan,
  'semantic-search': Sparkles,
  'detail-crop': Crop,
  'native-lease': Layers,
  'runner-defaults': Cpu,
  'load-balancer': Scale,
  failover: ShieldAlert,
}

/**
 * Orchestrator sections a panel never draws unless it asks for them by id: the
 * role pickers live in Roles & nodes, and the four load-balancer knobs are
 * drawn once, in their own card.
 */
const ELSEWHERE_SECTION_IDS: readonly string[] = ['cluster', LOAD_SETTINGS_SECTION_ID]

/**
 * Bring `?section=<id>` into view once its card has rendered — a link such as
 * the step panel's "Change in Cluster → Settings" lands on the card, not on
 * the top of the page. The forms load asynchronously, so it waits for the card
 * (a MutationObserver, bounded by unmount).
 */
function useScrollToSection(requested: string | null): void {
  useEffect(() => {
    if (requested === null) return
    const sectionId = LEGACY_SECTION_ALIASES[requested] ?? requested
    const selector = `[data-cluster-settings-card="${CSS.escape(sectionId)}"]`
    const reveal = (): boolean => {
      const el = document.querySelector<HTMLElement>(selector)
      if (el === null) return false
      el.scrollIntoView({ block: 'start', behavior: 'smooth' })
      el.classList.add('ring-2', 'ring-primary/60')
      setTimeout(() => el.classList.remove('ring-2', 'ring-primary/60'), SECTION_HIGHLIGHT_MS)
      return true
    }
    if (reveal()) return
    const observer = new MutationObserver(() => {
      if (reveal()) observer.disconnect()
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [requested])
}

function SettingsCard({ section }: { readonly section: ClusterSettingsSection }) {
  const { t } = useTranslation()
  return (
    <div data-cluster-settings-card={section.id} className="rounded-lg">
      <SectionCard
        headingId={`cluster-settings-${section.id}`}
        title={section.title}
        {...(SECTION_ICONS[section.id] !== undefined ? { icon: SECTION_ICONS[section.id] } : {})}
      >
        <div className={`${SECTION_BODY} space-y-3`}>
          <p className={TEXT_HINT}>{section.hint}</p>
          {section.panels.map((panel) => (
            <NodeAddonsSettingsPanel
              key={`${panel.addonId}:${panel.capability ?? ''}`}
              nodeId="hub"
              addonIds={[panel.addonId]}
              level="global"
              hideSectionChrome
              omitSectionIds={ELSEWHERE_SECTION_IDS.filter(
                (id) => !(panel.sectionIds ?? []).includes(id),
              )}
              emptyMessage={t(
                'pipeline.clusterSettingsTab.notAvailableTheAddonThat',
                'Not available — the addon that owns these settings did not answer.',
              )}
              {...(panel.capability !== undefined ? { capability: panel.capability } : {})}
              {...(panel.sectionIds !== undefined ? { sectionIds: panel.sectionIds } : {})}
              {...(panel.fieldKeys !== undefined ? { fieldKeys: panel.fieldKeys } : {})}
              {...(panel.fieldScope !== undefined ? { fieldScope: panel.fieldScope } : {})}
            />
          ))}
        </div>
      </SectionCard>
    </div>
  )
}

export function ClusterSettingsTab({ refreshToken: _refreshToken }: ClusterSettingsTabProps) {
  const [searchParams] = useSearchParams()
  useScrollToSection(searchParams.get(CLUSTER_SECTION_PARAM))
  return (
    <div className="space-y-3 sm:space-y-4">
      {CLUSTER_SETTINGS_SECTIONS.map((section) => (
        <SettingsCard key={section.id} section={section} />
      ))}
    </div>
  )
}
