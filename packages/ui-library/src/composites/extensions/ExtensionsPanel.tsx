/**
 * `host/extensions-panel` — what a device is extended with by OTHER devices,
 * in one place (D648).
 *
 * Mounted by the framework: `device-extension.cap.ts` declares
 * `deviceConfig.ui = { kind:'widget', widgetId:'host/extensions-panel',
 * tab:'general', order:72 }` and `deriveDeviceConfigContribution` emits the
 * section (D14). The panel STORES NOTHING: every card is one row of
 * `device-extension.listSlots`, read by the slot's owner from the store it
 * already has, and every save is `setSlot`, written by that owner through its
 * existing path. It is the only editor of what it shows: the hand-written
 * "Linked devices" and "Virtual doorbell" sections it replaced were retired
 * once the live read matched them on every measured camera (D655).
 *
 * Every slot is an ASSOCIATION, so every card is a device multiselect. A
 * device that GAINS a capability from other devices is a composition, not a
 * slot, and is authored there (D663, amends D648).
 *
 * Absence is claimed only from an answer (D315): pending, failed and empty
 * are three different sentences, and an owner that could not answer is shown
 * with its reason, verbatim — never dropped.
 */
import type { ExtensionSlotId } from '@camstack/types'
import { Puzzle } from 'lucide-react'
import { useDeviceExtensionListSlots } from '../../generated/system-hooks.js'
import { useUiText } from '../../contexts/ui-text.js'
import { Badge } from '../../primitives/badge.js'
import { ErrorBox } from '../error-box.js'
import { WidgetPanel } from '../widget-panel.js'
import { AssociationSlotCard } from './AssociationSlotCard.js'
import { resolveExtensionsView } from './extensions-view-state.js'
import { type JSX } from 'react'

export interface ExtensionsPanelProps {
  readonly deviceId: number
  /**
   * Only these slots are rendered; absent = every slot (the host widget's
   * behaviour, unchanged). An owner that could not answer is shown either way:
   * its row cannot say which slot it owns, and hiding it would read as
   * "nothing configured" (D315). Used by the Customize tab (D676).
   */
  readonly slots?: readonly ExtensionSlotId[]
  /** Panel title; absent = "Extensions". */
  readonly title?: string
  /**
   * No Edit affordance on any card (`setSlot` is `auth: 'admin'`). Used by a
   * viewer who can read `listSlots` (`protected`) but not write — never a
   * reason to hide the saved picks themselves.
   */
  readonly readOnly?: boolean
}

export function ExtensionsPanel({
  deviceId,
  slots,
  title,
  readOnly = false,
}: ExtensionsPanelProps): JSX.Element {
  const t = useUiText()
  const query = useDeviceExtensionListSlots({ deviceId })
  const view = resolveExtensionsView(
    {
      status: query.status,
      data: query.data,
      error: query.error,
    },
    undefined,
    t,
  )
  // A slot is shown when the caller named it, or named none. One rule for the
  // cards AND for the rows of slots this build does not declare (R1).
  const named = (slot: string): boolean => slots === undefined || slots.some((id) => id === slot)
  const shown = view.kind !== 'rows' ? [] : view.slots.filter((row) => named(row.slot))
  const unknownShown =
    view.kind !== 'rows' ? [] : view.unknownSlots.filter((row) => named(row.slot))
  const panelTitle = title ?? t('uiLibrary.extensionsPanel.title', 'Extensions')
  // The owners answered and none of them offers a chosen slot: that is an
  // answer, so it is said (D315) — an empty card would read as still loading.
  // With an unreachable owner beside it, its row already says what is unknown.
  const filteredToNothing =
    view.kind === 'rows' &&
    slots !== undefined &&
    shown.length === 0 &&
    unknownShown.length === 0 &&
    view.unreachable.length === 0

  return (
    <WidgetPanel
      title={panelTitle}
      icon={<Puzzle className="h-3.5 w-3.5 text-foreground-subtle" />}
      bodyClassName="p-3"
    >
      <section aria-label={panelTitle} className="flex flex-col gap-3">
        {view.kind === 'pending' && (
          <p role="status" className="text-[11px] text-foreground-subtle">
            {t('uiLibrary.extensionsPanel.loading', 'Loading this device’s extensions…')}
          </p>
        )}
        {view.kind === 'unknown' && (
          <ErrorBox
            title={t('uiLibrary.extensionsPanel.unknownTitle', 'Extensions could not be read')}
            message={t(
              'uiLibrary.extensionsPanel.unknownMessage',
              'Nothing is known about this device’s extensions yet: {{reason}}',
              { reason: view.reason },
            )}
            onRetry={() => void query.refetch()}
          />
        )}
        {view.kind === 'none' && (
          <p role="status" className="text-[11px] text-foreground-subtle italic">
            {t('uiLibrary.extensionsPanel.none', 'No extensions are offered on this device.')}
          </p>
        )}
        {view.kind === 'rows' && (
          <>
            {filteredToNothing && (
              <p role="status" className="text-[11px] text-foreground-subtle italic">
                {t(
                  'uiLibrary.extensionsPanel.filteredToNothing',
                  'None of these extensions is offered on this device.',
                )}
              </p>
            )}
            {shown.map((row) => (
              <AssociationSlotCard
                key={row.slotRef}
                deviceId={deviceId}
                row={row}
                onSaved={() => void query.refetch()}
                readOnly={readOnly}
              />
            ))}
            {unknownShown.map((row) => (
              <div
                key={`unknown:${row.slotRef}`}
                role="alert"
                className="flex flex-col gap-1 rounded-md border border-warning/40 bg-warning/5 p-3"
              >
                <div className="flex items-center gap-2">
                  <Badge variant="warning">
                    {t('uiLibrary.extensionsPanel.unknownSlot', 'Unknown slot')}
                  </Badge>
                  <span className="text-xs font-semibold text-foreground">{row.slot}</span>
                </div>
                <p className="text-[11px] text-foreground-muted break-words">{row.slotRef}</p>
                <p className="text-[10px] text-foreground-subtle">
                  {t(
                    'uiLibrary.extensionsPanel.disagree',
                    'The admin UI and the server disagree: the server offers a slot this admin UI does not know. Update the admin UI, or the server.',
                  )}
                </p>
              </div>
            ))}
            {view.unreachable.map((row) => (
              <div
                key={`unreachable:${row.addonId}`}
                role="alert"
                className="flex flex-col gap-1 rounded-md border border-warning/40 bg-warning/5 p-3"
              >
                <div className="flex items-center gap-2">
                  <Badge variant="warning">
                    {t('uiLibrary.extensionsPanel.unreachable', 'Unreachable')}
                  </Badge>
                  <span className="text-xs font-semibold text-foreground">{row.addonId}</span>
                </div>
                <p className="text-[11px] text-foreground-muted break-words">{row.reason}</p>
                <p className="text-[10px] text-foreground-subtle">
                  {t(
                    'uiLibrary.extensionsPanel.unreachableHint',
                    'The extensions this component owns are unknown until it answers.',
                  )}
                </p>
              </div>
            ))}
          </>
        )}
      </section>
    </WidgetPanel>
  )
}
