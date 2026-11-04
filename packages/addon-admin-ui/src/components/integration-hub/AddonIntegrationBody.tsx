/**
 * The body of an addon-backed integration, the same on every integration page:
 *
 *   ┌ status strip ─ badges · addon id ───────── primary · Enable · Restart ┐
 *   │ error (when the page reports one)                                    │
 *   │ lead — an unheaded block the page wants seen first (pairing / setup) │
 *   │ the page's own panels (peers, ICE servers, hints, brokers)           │
 *   │ Settings — the addon's schema, through the form builder              │
 *   │ Activity — Logs | Events                                             │
 *   │ the page's `placement: 'end'` panels (an exporter's devices table)   │
 *   └──────────────────────────────────────────────────────────────────────┘
 *
 * A long list goes LAST (`placement: 'end'`): the operator asked for the
 * exporter's devices table under settings and activity, so the controls he
 * reaches for are not pushed below a hundred rows. A deep link to it
 * (`?section=devices`) still scrolls there — the section is the same, only
 * its position changed.
 *
 * Settings and Activity stay on one scroll, deliberately: the operator edits a
 * setting while watching what the addon logs about it. Every section is a
 * deep-link target (`?section=`), so a link can still land straight on one.
 *
 * Settings default to the addon's `globalSettingsSchema()` via
 * `NodeAddonsSettingsPanel`. A page may pass `settingsContent` to replace that
 * body inside the same Settings section (e.g. auth-oidc DataTable + dialog) —
 * still not a new panel id.
 */
import { Settings2, type LucideIcon } from 'lucide-react'
import type { ReactElement, ReactNode } from 'react'
import { ErrorBox } from '@camstack/ui-library'

import { SETTINGS_SECTION } from '../../lib/integration-hub-url'
import { NodeAddonsSettingsPanel } from '../settings/NodeAddonsSettingsPanel'
import { EnableToggleButton, EnabledBadge, RestartButton } from './addon-controls'
import { IntegrationActivity } from './IntegrationActivity'
import { IntegrationSection } from './IntegrationSection'
import { useTranslation } from 'react-i18next'

export interface IntegrationPanel {
  /** The `?section=` id that targets it (`devices`, `peers`, …). */
  readonly id: string
  readonly title: string
  readonly icon?: LucideIcon
  readonly content: ReactNode
  /**
   * `top` (default): above Settings. `end`: after Activity, the body's last
   * element — for a long table that would otherwise push Settings and
   * Activity off screen.
   */
  readonly placement?: 'top' | 'end'
}

export interface AddonIntegrationBodyProps {
  readonly addonId: string
  readonly displayName: string
  /** The capability the Enable toggle flips and the settings are scoped to. */
  readonly capName: string
  readonly isActive: boolean
  /** Page-specific status pills, after the common Enabled badge. */
  readonly badges?: ReactNode
  /** The page-specific lifecycle action (Start/Stop, Connect/Log out). */
  readonly primaryAction?: ReactNode
  /** A per-integration error, shown above everything else. */
  readonly error?: string | null
  /**
   * Shown under the status strip, without a section heading of its own — a
   * block that must be seen first and renders nothing when it has nothing to
   * say (an exporter's pairing QR / error, `DeviceExportSetup`).
   */
  readonly lead?: ReactNode
  /** The page's sections, above Settings or (`placement: 'end'`) after Activity. */
  readonly panels?: readonly IntegrationPanel[]
  /**
   * When set, replaces `NodeAddonsSettingsPanel` inside the Settings section
   * (same `?section=settings`). Used when the addon owns entry CRUD outside
   * an editable-array schema. `null` drops the Settings section altogether —
   * for an addon whose configuration lives on its instances, so the global
   * schema is empty.
   */
  readonly settingsContent?: ReactNode | null
}

export function AddonIntegrationBody({
  addonId,
  displayName,
  capName,
  isActive,
  badges,
  primaryAction,
  error = null,
  lead,
  panels = [],
  settingsContent,
}: AddonIntegrationBodyProps): ReactElement {
  const { t } = useTranslation()
  const topPanels = panels.filter((p) => p.placement !== 'end')
  const endPanels = panels.filter((p) => p.placement === 'end')
  return (
    <div className="flex flex-col gap-4">
      <StatusStrip
        addonId={addonId}
        displayName={displayName}
        capName={capName}
        isActive={isActive}
        badges={badges}
        primaryAction={primaryAction}
      />
      {error !== null && <ErrorBox message={error} />}
      {lead}
      <PanelSections panels={topPanels} />
      {settingsContent !== null && (
        <IntegrationSection
          id={SETTINGS_SECTION}
          title={t('integrationHub.addonIntegrationBody.settings', 'Settings')}
          icon={Settings2}
        >
          {settingsContent !== undefined ? (
            settingsContent
          ) : (
            <NodeAddonsSettingsPanel
              nodeId="hub"
              addonIds={[addonId]}
              level="global"
              capability={capName}
            />
          )}
        </IntegrationSection>
      )}
      <IntegrationActivity addonId={addonId} />
      <PanelSections panels={endPanels} />
    </div>
  )
}

function PanelSections({ panels }: { readonly panels: readonly IntegrationPanel[] }): ReactElement {
  return (
    <>
      {panels.map((panel) => (
        <IntegrationSection key={panel.id} id={panel.id} title={panel.title} icon={panel.icon}>
          {panel.content}
        </IntegrationSection>
      ))}
    </>
  )
}

/**
 * The integration's state and its controls, in one slim row. Not a hero: the
 * header's pill already shows WHICH integration this is (icon + name); this
 * row says how it is doing and what can be done about it.
 */
function StatusStrip({
  addonId,
  displayName,
  capName,
  isActive,
  badges,
  primaryAction,
}: Omit<AddonIntegrationBodyProps, 'error' | 'lead' | 'panels'>): ReactElement {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface px-2 py-1.5 sm:px-3"
      data-testid="integration-status-strip"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <EnabledBadge isActive={isActive} />
        {badges}
        {/* The addon id, verbatim — never a package name synthesised from it
            (bundles ship several addons; `@camstack/addon-<id>` may not exist). */}
        <span className="break-all font-mono text-[11px] text-foreground-subtle">{addonId}</span>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1">
        {primaryAction}
        <EnableToggleButton capName={capName} addonId={addonId} isActive={isActive} />
        <RestartButton addonId={addonId} displayName={displayName} />
      </div>
    </div>
  )
}
