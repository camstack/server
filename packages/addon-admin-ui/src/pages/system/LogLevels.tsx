/**
 * Levels — the log-level HIERARCHY, cluster → node, with `effective` and
 * `explicit` visibly different.
 *
 * ## Why both are on screen at once
 *
 * `system.getLoggingSettings` returns `effective` (what a line is judged
 * against, plus WHICH layer decided it) and `explicit` (what each layer
 * actually holds, where a layer that inherits reads `null`). Showing only the
 * resolved value is the defect this page exists to remove: an operator who
 * clears a node override believing they are clearing an inherited value has no
 * way to tell what they just did.
 *
 * So each layer row shows one of exactly two things — never a number that
 * could be either:
 *
 *   - a SET pill with the level and a Clear button  → this layer decided it
 *   - the word "inherits" in muted text             → this layer holds nothing
 *
 * and the row that supplied the effective value carries the "in force" badge.
 * A glance answers "who decided this", which is the question.
 *
 * ## What the floor does
 *
 * It gates the fan-out to log DESTINATIONS (console, files, Loki, the hub
 * forwarder). The in-memory ring the Viewer tab reads keeps every line either
 * way — raising the level to quieten a disk must not blind the log viewer.
 * Each destination's own level still applies on top; the strictest wins.
 *
 * ## The third layer: COMPONENT
 *
 * A component is a log CHANNEL an addon declared (`stream-broker.webrtc`,
 * `provider-reolink.baichuan`) — the roster comes from the addons themselves
 * through `log-channels`, never from a list in this file, so a channel added
 * by a redeployed addon shows up here without anybody editing the UI.
 *
 * A component level is CLUSTER-WIDE and the node selector is disabled while
 * one is picked. That is not a limitation to work around: a channel means the
 * same thing wherever its addon runs, and a per-node copy would be the second
 * knob that disagrees with the first.
 */
import { useMemo, useState, type ReactElement } from 'react'
import { Check, Layers, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  useClusterNodes,
  useSystemGetLoggingSettings,
  useSystemSetLoggingSettings,
  Button,
  Input,
  Select,
} from '@camstack/ui-library'
import type { LoggingLevelLayer, LogLevel } from '@camstack/types'
import { AdminPage } from '../../components/AdminPage'

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']

/** The cluster layer is addressed by the ABSENCE of a scope, never by a name. */
const CLUSTER_SCOPE = ''

/** No component layer addressed. Same convention: absence, not a magic name. */
const NO_COMPONENT = ''

interface NodeOption {
  readonly id: string
  readonly label: string
}

export function LogLevelsPage(): ReactElement {
  const { t } = useTranslation()
  const [scope, setScope] = useState<string>(CLUSTER_SCOPE)
  const [component, setComponent] = useState<string>(NO_COMPONENT)

  // A node picker needs the ROSTER, not the cluster diagram (D317).
  const { nodes: clusterNodes } = useClusterNodes()
  const nodeOptions = useMemo<readonly NodeOption[]>(
    () => clusterNodes.map((n) => ({ id: n.id, label: n.name || n.id })),
    [clusterNodes],
  )

  const settings = useSystemGetLoggingSettings(
    {
      ...(scope === CLUSTER_SCOPE ? {} : { scopeNodeId: scope }),
      ...(component === NO_COMPONENT ? {} : { scopeComponent: component }),
    },
    { refetchInterval: 15_000 },
  )
  const write = useSystemSetLoggingSettings()

  const state = settings.data
  const busy = write.isPending || settings.isFetching

  /** The roster comes from the ADDONS, never from a list in this file. */
  const channelOptions = state?.channels ?? []

  /**
   * Address the layer the ROW speaks for, never the layer the page is
   * currently viewing. A row carries its own `nodeId`/`component`, so
   * clearing the cluster while looking at a component cannot be mistaken for
   * clearing the component.
   */
  const apply = (layer: LoggingLevelLayer, level: LogLevel | null): void => {
    write.mutate(
      {
        ...(layer.nodeId !== null ? { scopeNodeId: layer.nodeId } : {}),
        ...(layer.component !== null ? { scopeComponent: layer.component } : {}),
        patch: { level },
      },
      { onSuccess: () => void settings.refetch() },
    )
  }

  return (
    <AdminPage
      embedded
      icon={Layers}
      title={t('logging.levels.title', 'Levels')}
      subtitle={t(
        'logging.levels.subtitle',
        'Cluster → node, most specific wins. The floor gates what reaches the log destinations; the in-memory viewer keeps every line either way.',
      )}
      actions={
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-foreground-subtle">
            {t('logging.levels.scope', 'Scope')}
            <Select
              wrapperClassName="inline-block w-auto"
              value={scope}
              // A component level is cluster-wide; offering a node alongside it
              // would imply a per-node component value that does not exist.
              disabled={component !== NO_COMPONENT}
              onChange={(e) => setScope(e.target.value)}
            >
              <option value={CLUSTER_SCOPE}>{t('logging.levels.cluster', 'Cluster')}</option>
              {nodeOptions.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex items-center gap-2 text-xs text-foreground-subtle">
            {t('logging.levels.component', 'Component')}
            <Select
              wrapperClassName="inline-block w-auto"
              value={component}
              onChange={(e) => setComponent(e.target.value)}
            >
              <option value={NO_COMPONENT}>{t('logging.levels.noComponent', 'None')}</option>
              {channelOptions.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </Select>
          </label>
        </div>
      }
    >
      {settings.isLoading || state === undefined ? (
        <div className="flex items-center gap-2 text-xs text-foreground-subtle">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('common.loading', 'Loading…')}
        </div>
      ) : (
        <div className="space-y-3">
          <EffectiveBanner
            level={state.effective.level}
            source={state.effective.levelSource}
            persisted={state.persisted}
          />
          <div className="rounded-lg border border-border bg-surface divide-y divide-border">
            {state.explicit.layers.map((layer) => (
              <LayerRow
                key={`${layer.scope}:${layer.nodeId ?? layer.component ?? 'cluster'}`}
                layer={layer}
                inForce={layer.scope === state.effective.levelSource}
                busy={busy}
                onSet={(level) => apply(layer, level)}
                onClear={() => apply(layer, null)}
              />
            ))}
          </div>
          {component !== NO_COMPONENT && (
            <p className="text-[11px] text-foreground-subtle">
              {channelOptions.find((c) => c.name === component)?.description ?? ''}
            </p>
          )}
          <p className="text-[11px] text-foreground-subtle">
            {t(
              'logging.levels.componentNote',
              'A component is a log channel an addon declared. Its level is cluster-wide and beats both the node and the cluster layer.',
            )}
          </p>
          <OpsLogRetention
            days={state.opsLogRetentionDays}
            busy={busy}
            onSet={(days) =>
              write.mutate(
                { patch: { opsLogRetentionDays: days } },
                { onSuccess: () => void settings.refetch() },
              )
            }
          />
        </div>
      )}
    </AdminPage>
  )
}

/**
 * How long the analytics OPS LOG is kept — the audit trail of what retention
 * actually deleted.
 *
 * It is on this page, and not on the analytics settings form, on the operator's
 * instruction: every other log-ish window is configured through this one
 * document, and a retention audit configured elsewhere is a second place to
 * look when the question is "what happened to my data".
 *
 * Cluster-wide: it is written with no `scopeNodeId`, whatever layer the page is
 * viewing. An audit whose length differed per node would answer that question
 * differently depending on which node you asked.
 */
function OpsLogRetention({
  days,
  busy,
  onSet,
}: {
  readonly days: number
  readonly busy: boolean
  readonly onSet: (days: number) => void
}): ReactElement {
  const { t } = useTranslation()
  return (
    <div className="rounded-lg border border-border bg-surface p-3 space-y-1">
      <label className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium">
          {t('logging.levels.opsLogRetention', 'Retention audit trail')}
        </span>
        <span className="flex items-center gap-1.5">
          <Input
            type="number"
            min={0}
            max={3650}
            step={1}
            defaultValue={days}
            disabled={busy}
            onBlur={(e) => {
              const next = Number.parseInt(e.target.value, 10)
              if (Number.isFinite(next) && next !== days) onSet(next)
            }}
            className="w-20 rounded border border-border bg-surface px-2 py-1 text-xs"
          />
          <span className="text-[11px] text-foreground-subtle">{t('common.days', 'days')}</span>
        </span>
      </label>
      <p className="text-[11px] text-foreground-subtle">
        {t(
          'logging.levels.opsLogRetentionNote',
          'How long the record of what retention deleted is kept. Cluster-wide, and deliberately longer than any camera window — it is the history of the sweep, not of the camera, and it is what makes a storage leak explainable after the fact. 0 keeps it forever.',
        )}
      </p>
    </div>
  )
}

function EffectiveBanner({
  level,
  source,
  persisted,
}: {
  readonly level: LogLevel
  readonly source: string
  readonly persisted: boolean
}): ReactElement {
  const { t } = useTranslation()
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-foreground-subtle">
          {t('logging.levels.effective', 'In force here')}
        </span>
        <span className="rounded bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
          {level}
        </span>
        <span className="text-[11px] text-foreground-subtle">
          {source === 'default'
            ? t('logging.levels.fromDefault', 'nothing is set anywhere — this is the default')
            : t('logging.levels.fromLayer', 'decided by the {{source}} layer', { source })}
        </span>
      </div>
      {!persisted && (
        <p className="mt-1 text-[11px] text-warning">
          {t(
            'logging.levels.notPersisted',
            'The settings store could not be read or written — what you see is live, but it would not survive a restart.',
          )}
        </p>
      )}
    </div>
  )
}

function LayerRow({
  layer,
  inForce,
  busy,
  onSet,
  onClear,
}: {
  readonly layer: LoggingLevelLayer
  readonly inForce: boolean
  readonly busy: boolean
  readonly onSet: (level: LogLevel) => void
  readonly onClear: () => void
}): ReactElement {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">
            {layer.scope === 'cluster'
              ? t('logging.levels.cluster', 'Cluster')
              : layer.scope === 'component'
                ? (layer.component ?? '')
                : (layer.nodeId ?? '')}
          </span>
          {inForce && (
            <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
              <Check className="h-3 w-3" />
              {t('logging.levels.inForce', 'in force')}
            </span>
          )}
        </div>
        {/* The one distinction the page exists for: a layer that holds nothing
            says so in words, and never shows the value it inherits. */}
        <p className="mt-0.5 text-[11px] text-foreground-subtle">
          {layer.level === null
            ? t('logging.levels.inherits', 'inherits — nothing set at this layer')
            : t('logging.levels.setHere', 'set here: {{level}}', { level: layer.level })}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {LEVELS.map((level) => (
          <Button
            variant="unstyled"
            key={level}
            type="button"
            disabled={busy}
            onClick={() => onSet(level)}
            className={`rounded px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 ${
              layer.level === level
                ? 'bg-primary text-primary-foreground'
                : 'border border-border text-foreground-subtle hover:text-foreground'
            }`}
          >
            {level}
          </Button>
        ))}
        <Button
          variant="unstyled"
          type="button"
          disabled={busy || layer.level === null}
          onClick={onClear}
          className="rounded border border-border px-2 py-1 text-[11px] text-foreground-subtle hover:text-foreground disabled:opacity-40"
        >
          {t('logging.levels.clear', 'Clear')}
        </Button>
      </div>
    </div>
  )
}
