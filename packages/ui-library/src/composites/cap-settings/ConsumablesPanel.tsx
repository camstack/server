/**
 * ConsumablesPanel — the ONE consumables surface of every device (D915): wear
 * parts, tanks (a vacuum's clean and dirty water), products (detergent, a
 * dishwasher's salt and rinse aid) and bins (a dust bin), for whichever device
 * is bound to the `consumables` capability. A cap-settings component
 * (ui-library), shown directly under the device page's hero card through the
 * cap-UI contribution mechanism (the cap declares
 * `ui: { kind:'widget', widgetId:'host/consumables-panel', placement:'hero', ... }`)
 * — never drawn by a device type's hero card itself.
 *
 * Reads the cap's pushed runtime-state slice via `useDeviceCapability` and
 * renders one row per item, drawn by its form (`consumable-rows.tsx`). A
 * slice that has not landed is a loading line, never "none reported" (D315).
 *
 * The section COLLAPSES smartly: it starts open while any item needs
 * attention (low, empty, a full bin or waste tank, a part to replace) and
 * closed while every item is ok or unknown; closed, its header carries a
 * one-line summary (`consumables-summary.ts`). The operator's own toggle wins
 * and is remembered per device and per viewer.
 */
import { useUiText, type UiTextFn } from '../../contexts/ui-text'
import { useCallback, useState, type JSX, type ReactNode } from 'react'
import { Gauge } from 'lucide-react'
import type { ConsumablesStatus } from '@camstack/types'
import { useSystem } from '../../contexts/system-context'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { usePersistedDisclosure } from '../../hooks/use-persisted-disclosure'
import { WidgetPanel } from '../widget-panel'
import { ConsumableLevelBadge, consumableLevelVariant } from '../consumable-level-badge'
import { Badge } from '../../primitives/badge'
import { Skeleton } from '../../primitives/skeleton'
import { ConsumableRow } from './consumable-rows'
import { summarizeConsumables, type ConsumablesSummary } from './consumables-summary'
import type { CapSettingsComponentProps } from './index'

/** Where one viewer's open / closed choice for one device's section is kept. */
export function consumablesOpenStorageKey(deviceId: number): string {
  return `camstack.device.${String(deviceId)}.consumables.open`
}

/** The one line a collapsed section says. */
function SummaryLine({
  summary,
  t,
}: {
  readonly summary: ConsumablesSummary
  readonly t: UiTextFn
}): ReactNode {
  switch (summary.kind) {
    case 'none':
      return (
        <Badge variant="neutral" size="sm">
          {t('uiLibrary.consumablesPanel.noneReported', 'None reported')}
        </Badge>
      )
    case 'ok':
      return (
        <Badge variant="success" size="sm">
          {t('uiLibrary.consumablesPanel.allOk', 'All OK')}
        </Badge>
      )
    case 'partial':
      return (
        <Badge variant="neutral" size="sm">
          {t('uiLibrary.consumablesPanel.okAndUnknown', '{{ok}} OK · {{unknown}} unknown', {
            ok: summary.ok,
            unknown: summary.unknown,
          })}
        </Badge>
      )
    case 'attention':
      return summary.count === 1 ? (
        <ConsumableLevelBadge
          level={summary.worst.level}
          name={summary.worst.label}
          size="sm"
          label={
            summary.worst.replace ? t('uiLibrary.consumablesPanel.replace', 'Replace') : undefined
          }
        />
      ) : (
        <Badge variant={consumableLevelVariant(summary.worst.level)} size="sm">
          {t(
            'uiLibrary.consumablesPanel.needAttention',
            { one: '{{count}} needs attention', other: '{{count}} need attention' },
            { count: summary.count },
          )}
        </Badge>
      )
  }
}

export function ConsumablesPanel({ deviceId }: CapSettingsComponentProps): JSX.Element {
  const t = useUiText()
  const system = useSystem()
  const ready = Number.isFinite(deviceId)
  const { cap, slice, available } = useDeviceCapability<
    { reset: (input: { key: string }) => Promise<void> },
    ConsumablesStatus
  >({
    trpc: system.trpcClient,
    deviceId: ready ? deviceId : null,
    cap: (d) => d.consumables,
    slice: (d) => d.state.consumables,
  })
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [choice, setChoice] = usePersistedDisclosure(
    ready ? consumablesOpenStorageKey(deviceId) : null,
  )

  const onReset = useCallback(
    async (key: string): Promise<void> => {
      if (!cap) return
      setBusyKey(key)
      try {
        await cap.reset({ key })
      } catch (err: unknown) {
        // eslint-disable-next-line no-console -- error-path diagnostic; UI code has no scoped logger
        console.error('consumables.reset failed', err)
      } finally {
        setBusyKey(null)
      }
    },
    [cap],
  )

  const summary = slice === undefined ? null : summarizeConsumables(slice.items)
  // The viewer's own choice wins; else open exactly while something needs attention.
  const open = choice ?? summary?.needsAttention ?? false
  const loading = (
    <Skeleton
      className={open ? 'h-10 w-full' : 'h-4 w-16'}
      data-testid="consumables-loading"
      aria-label={t('uiLibrary.consumablesPanel.loading', 'Reading consumables…')}
    />
  )

  return (
    <WidgetPanel
      title={t('uiLibrary.consumablesPanel.title', 'Consumables')}
      icon={<Gauge className="h-3.5 w-3.5 text-foreground-subtle" />}
      bodyClassName="p-3 overflow-y-auto"
      collapsible
      open={open}
      onOpenChange={setChoice}
      headerRight={
        open ? undefined : summary === null ? loading : <SummaryLine summary={summary} t={t} />
      }
    >
      {slice === undefined ? (
        loading
      ) : slice.items.length === 0 ? (
        <p className="text-[11px] text-foreground-subtle italic leading-relaxed">
          {t('uiLibrary.consumablesPanel.empty', 'No consumables reported.')}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {slice.items.map((item) => (
            <ConsumableRow
              key={item.key}
              item={item}
              busy={busyKey === item.key}
              canReset={available}
              onReset={(key) => void onReset(key)}
            />
          ))}
        </div>
      )}
    </WidgetPanel>
  )
}
