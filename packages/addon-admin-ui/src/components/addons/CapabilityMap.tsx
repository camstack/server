import { CheckCircle, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, Checkbox } from '@camstack/ui-library'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CapabilityMode = 'singleton' | 'collection'

export interface CapabilityProvider {
  addonId: string
  addonName: string
  active: boolean
}

export interface NodeSelectionView {
  readonly nodeId: string
  readonly providers: readonly string[] // bare addonIds available on the node
  readonly resolvedActive: string | null
  readonly hasOverride: boolean
}

export interface CapabilityEntry {
  name: string
  mode: CapabilityMode
  providers: CapabilityProvider[]
  readonly perNode?: readonly NodeSelectionView[]
}

/**
 * Selection handlers. When provided, the cards render interactive controls:
 *   - singleton: a radio-style provider list that calls `onSelectSingleton`
 *   - collection: enable/disable checkboxes that call `onToggleCollection`
 *     with the FULL desired enabled set (the `setCollectionEnabledProviders`
 *     bulk contract).
 * When omitted, the map stays display-only (the original behaviour).
 */
export interface CapabilityMapActions {
  readonly onSelectSingleton: (capName: string, addonId: string) => void
  readonly onSelectNodeSingleton: (capName: string, nodeId: string, addonId: string) => void
  readonly onClearNodeSingleton: (capName: string, nodeId: string) => void
  readonly onToggleCollection: (capName: string, enabledAddonIds: readonly string[]) => void
  /** `capName` currently being mutated — disables its controls + shows a spinner. */
  readonly pendingCapability: string | null
}

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

const CAPABILITY_BORDER_COLORS: Record<string, string> = {
  detection: 'border-green-500',
  detector: 'border-green-500',
  streaming: 'border-blue-500',
  decode: 'border-blue-500',
  decoder: 'border-blue-500',
  recording: 'border-orange-500',
  recorder: 'border-orange-500',
  transcoding: 'border-purple-500',
  transcoder: 'border-purple-500',
  restream: 'border-cyan-500',
  restreamer: 'border-cyan-500',
  storage: 'border-yellow-500',
  notification: 'border-pink-500',
  notifier: 'border-pink-500',
  faces: 'border-indigo-500',
}

const CAPABILITY_BG_COLORS: Record<string, string> = {
  detection: 'bg-green-500/5',
  detector: 'bg-green-500/5',
  streaming: 'bg-blue-500/5',
  decode: 'bg-blue-500/5',
  decoder: 'bg-blue-500/5',
  recording: 'bg-orange-500/5',
  recorder: 'bg-orange-500/5',
  transcoding: 'bg-purple-500/5',
  transcoder: 'bg-purple-500/5',
  restream: 'bg-cyan-500/5',
  restreamer: 'bg-cyan-500/5',
  storage: 'bg-yellow-500/5',
  notification: 'bg-pink-500/5',
  notifier: 'bg-pink-500/5',
  faces: 'bg-indigo-500/5',
}

// ---------------------------------------------------------------------------
// CapabilityCard
// ---------------------------------------------------------------------------

interface CapabilityCardProps {
  readonly entry: CapabilityEntry
  readonly actions?: CapabilityMapActions
}

function CapabilityCard({ entry, actions }: CapabilityCardProps) {
  const lower = entry.name.toLowerCase()
  const borderColor = CAPABILITY_BORDER_COLORS[lower] ?? 'border-primary'
  const bgColor = CAPABILITY_BG_COLORS[lower] ?? 'bg-primary/5'
  const activeProvider = entry.providers.find((p) => p.active)
  const isPending = actions?.pendingCapability === entry.name

  return (
    <div
      className={`rounded-lg border-t-2 border border-border ${borderColor} ${bgColor} p-3 space-y-2`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-foreground capitalize flex items-center gap-1.5">
          {entry.name}
          {isPending && <Loader2 className="h-3 w-3 animate-spin text-primary" />}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${entry.mode === 'singleton' ? 'bg-primary/10 text-primary' : 'bg-info/10 text-info'}`}
        >
          {entry.mode}
        </span>
      </div>

      {entry.mode === 'singleton' ? (
        <SingletonBody
          entry={entry}
          actions={actions}
          activeProvider={activeProvider}
          isPending={isPending}
        />
      ) : (
        <CollectionBody entry={entry} actions={actions} isPending={isPending} />
      )}
    </div>
  )
}

// ── Singleton ────────────────────────────────────────────────────────────

interface SingletonBodyProps {
  readonly entry: CapabilityEntry
  readonly actions?: CapabilityMapActions
  readonly activeProvider?: CapabilityProvider
  readonly isPending: boolean
}

function SingletonBody({ entry, actions, activeProvider, isPending }: SingletonBodyProps) {
  const { t } = useTranslation()
  // Display-only mode (no actions) — keep the original compact summary.
  if (!actions) {
    return (
      <div>
        {activeProvider ? (
          <div className="flex items-center gap-1.5 text-[10px] text-foreground">
            <CheckCircle className="h-3 w-3 text-green-400 shrink-0" />
            <span className="font-medium">{activeProvider.addonName}</span>
            <span className="rounded-full bg-green-500/10 text-green-400 px-1.5 py-0.5 font-medium ml-auto">
              ACTIVE
            </span>
          </div>
        ) : (
          <div className="text-[10px] text-foreground-subtle italic">
            {t('addons.capabilityMap.noActiveProvider', 'No active provider')}
          </div>
        )}
      </div>
    )
  }

  if (entry.providers.length === 0) {
    return (
      <div className="text-[10px] text-foreground-subtle italic">
        {t('addons.capabilityMap.noProviders', 'No providers')}
      </div>
    )
  }

  // Interactive: a radio list. Selecting a non-active provider swaps it.
  const INHERIT = '__inherit__'

  return (
    <div className="space-y-2">
      {/* Global provider radio list */}
      <div className="space-y-1">
        {entry.providers.map((p) => {
          const selected = p.active
          return (
            <Button
              variant="unstyled"
              key={p.addonId}
              type="button"
              disabled={isPending || selected}
              onClick={() => actions.onSelectSingleton(entry.name, p.addonId)}
              className={`flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-[10px] text-left transition-colors ${
                selected
                  ? 'bg-green-500/10 text-foreground cursor-default'
                  : 'text-foreground-subtle hover:bg-surface-hover hover:text-foreground disabled:opacity-50'
              }`}
            >
              <span
                className={`h-2.5 w-2.5 rounded-full border shrink-0 ${
                  selected ? 'border-green-400 bg-green-400' : 'border-border'
                }`}
              />
              <span className="font-medium truncate">{p.addonName}</span>
              {selected && (
                <span className="rounded-full bg-green-500/10 text-green-400 px-1.5 py-0.5 font-medium ml-auto shrink-0">
                  ACTIVE
                </span>
              )}
            </Button>
          )
        })}
      </div>

      {/* Per-node override sub-sections */}
      {entry.perNode && entry.perNode.length > 0 && (
        <div className="space-y-2 pt-1 border-t border-border/40">
          {entry.perNode.map((nv) => {
            const selected = nv.hasOverride && nv.resolvedActive ? nv.resolvedActive : INHERIT
            const options: { value: string; label: string }[] = [
              {
                value: INHERIT,
                label: nv.resolvedActive
                  ? t('addons.capabilityMap.inheritGlobalWith', { provider: nv.resolvedActive })
                  : t('addons.capabilityMap.inheritGlobal'),
              },
              ...nv.providers.map((p) => ({ value: p, label: p })),
            ]
            const onChange = (value: string): void => {
              if (value === INHERIT) {
                actions.onClearNodeSingleton(entry.name, nv.nodeId)
              } else {
                actions.onSelectNodeSingleton(entry.name, nv.nodeId, value)
              }
            }
            const disabled = isPending

            return (
              <div key={nv.nodeId} className="space-y-0.5">
                <div className="text-[9px] font-semibold uppercase tracking-widest text-foreground-subtle/60 px-1.5">
                  {nv.nodeId}
                  {nv.hasOverride && (
                    <span className="ml-1.5 rounded-full bg-primary/10 text-primary px-1 py-0.5 normal-case tracking-normal font-medium">
                      {t('common.override')}
                    </span>
                  )}
                </div>
                {options.map((opt) => {
                  const isSelected = selected === opt.value
                  return (
                    <Button
                      variant="unstyled"
                      key={opt.value}
                      type="button"
                      disabled={disabled || isSelected}
                      onClick={() => onChange(opt.value)}
                      className={`flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-[10px] text-left transition-colors ${
                        isSelected
                          ? 'bg-green-500/10 text-foreground cursor-default'
                          : 'text-foreground-subtle hover:bg-surface-hover hover:text-foreground disabled:opacity-50'
                      }`}
                    >
                      <span
                        className={`h-2.5 w-2.5 rounded-full border shrink-0 ${
                          isSelected ? 'border-green-400 bg-green-400' : 'border-border'
                        }`}
                      />
                      <span className="font-medium truncate">{opt.label}</span>
                      {isSelected && opt.value !== INHERIT && (
                        <span className="rounded-full bg-green-500/10 text-green-400 px-1.5 py-0.5 font-medium ml-auto shrink-0">
                          ACTIVE
                        </span>
                      )}
                    </Button>
                  )
                })}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Collection ───────────────────────────────────────────────────────────

interface CollectionBodyProps {
  readonly entry: CapabilityEntry
  readonly actions?: CapabilityMapActions
  readonly isPending: boolean
}

function CollectionBody({ entry, actions, isPending }: CollectionBodyProps) {
  const { t } = useTranslation()
  if (entry.providers.length === 0) {
    return (
      <div className="text-[10px] text-foreground-subtle italic">
        {t('addons.capabilityMap.noProviders', 'No providers')}
      </div>
    )
  }

  // Display-only mode — original read-out.
  if (!actions) {
    return (
      <div className="space-y-1">
        {entry.providers.map((p) => (
          <div key={p.addonId} className="flex items-center justify-between gap-2 text-[10px]">
            <span className="text-foreground-subtle">{p.addonName}</span>
            {p.active && (
              <span className="rounded-full bg-green-500/10 text-green-400 px-1.5 py-0.5 font-medium">
                ACTIVE
              </span>
            )}
          </div>
        ))}
      </div>
    )
  }

  // Interactive: toggling a provider sends the FULL desired enabled set,
  // matching `setCollectionEnabledProviders`' bulk contract.
  const enabledIds = entry.providers.filter((p) => p.active).map((p) => p.addonId)
  const toggle = (addonId: string, enable: boolean): void => {
    const next = enable
      ? [...new Set([...enabledIds, addonId])]
      : enabledIds.filter((id) => id !== addonId)
    actions.onToggleCollection(entry.name, next)
  }

  return (
    <div className="space-y-1">
      {entry.providers.map((p) => (
        <label
          key={p.addonId}
          className={`flex items-center justify-between gap-2 text-[10px] rounded px-1.5 py-1 transition-colors ${
            isPending ? 'opacity-50' : 'hover:bg-surface-hover cursor-pointer'
          }`}
        >
          <span className="flex items-center gap-1.5 min-w-0">
            <Checkbox
              checked={p.active}
              disabled={isPending}
              onChange={(e) => toggle(p.addonId, e.target.checked)}
              className="h-3 w-3 accent-green-500 shrink-0"
            />
            <span className="text-foreground truncate">{p.addonName}</span>
          </span>
          {p.active && (
            <span className="rounded-full bg-green-500/10 text-green-400 px-1.5 py-0.5 font-medium shrink-0">
              ACTIVE
            </span>
          )}
        </label>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// CapabilityMap
// ---------------------------------------------------------------------------

interface CapabilityMapProps {
  readonly capabilities: CapabilityEntry[]
  /** Optional selection handlers — pass to make the cards interactive. */
  readonly actions?: CapabilityMapActions
}

export function CapabilityMap({ capabilities, actions }: CapabilityMapProps) {
  const { t } = useTranslation()
  if (capabilities.length === 0) {
    return (
      <div className="text-xs text-foreground-subtle text-center py-8">
        {t('addons.capabilityMap.noCapabilitiesRegistered', 'No capabilities registered')}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
      {capabilities.map((cap) => (
        <CapabilityCard key={cap.name} entry={cap} actions={actions} />
      ))}
    </div>
  )
}
