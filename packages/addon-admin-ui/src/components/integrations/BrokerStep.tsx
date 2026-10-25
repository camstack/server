/**
 * `BrokerStep` — the integration wizard's broker gate for `device-adoption`
 * addons (Approach A). A device-adoption integration stores ONLY a
 * `{ brokerId }`; the broker holds the real connection identity/credentials.
 * This step lets the operator resolve that `brokerId` two ways:
 *
 *   • **Use existing** — pick an already-registered broker of the required
 *     `kind` (filtered from `broker.list`) and confirm.
 *   • **Create new** — fill the kind-driven `<BrokerForm>` + a name, which
 *     calls `broker.add({ kind, name, settings })`; the returned `id` is the
 *     resolved broker.
 *
 * Either path ends in `onResolved(brokerId)`; the wizard then creates the
 * integration with `settings: { brokerId }`. There is NO kind-specific
 * branching here — `kind` is a data input that selects the broker list
 * filter and the `BrokerForm` schema; the same component serves every
 * device-adoption provider kind.
 */
import { useMemo, useState } from 'react'
import { Loader2, ChevronLeft } from 'lucide-react'
import { useBrokerList, useBrokerListProviders, useBrokerAdd } from '@camstack/ui-library'
import type { UnifiedBrokerInfo, UnifiedBrokerStatus, BrokerProviderInfo } from '@camstack/types'
import { BrokerForm } from '../brokers/BrokerForm'
import { AlexaLoginStep } from './AlexaLoginStep'
import { Trans, useTranslation } from 'react-i18next'

export interface BrokerStepProps {
  /** Broker kind the device-adoption addon requires (e.g. `home-assistant`). */
  readonly kind: string
  /** Resolve the wizard's broker selection to a single broker id. */
  readonly onResolved: (brokerId: string) => void
  /** Return to the provider picker. */
  readonly onBack: () => void
}

/** The `alexa` broker kind supports an interactive login mode in addition to
 *  the standard "use existing" and "create new (paste cookie)" modes. */
const ALEXA_BROKER_KIND = 'alexa'

type Mode = 'existing' | 'new' | 'alexa-login'

// ── List narrowing ───────────────────────────────────────────────────
// `useBrokerList` is wire-typed by codegen; narrow defensively rather than
// trusting the inferred shape blindly (mirrors `BrokerManager.asBrokerList`).
function asBrokerList(data: unknown): readonly UnifiedBrokerInfo[] {
  if (!Array.isArray(data)) return []
  return data.filter(
    (b): b is UnifiedBrokerInfo =>
      b !== null && typeof b === 'object' && typeof (b as { id?: unknown }).id === 'string',
  )
}

// Resolve the addon that provides a given broker `kind` from
// `listProviders()` so create routes to that provider via the
// `{ addonId }` selector (the no-addonId fallback would hit the
// first-registered broker provider, which rejects a foreign kind).
function asProviderList(data: unknown): readonly BrokerProviderInfo[] {
  if (!Array.isArray(data)) return []
  return data.filter(
    (p): p is BrokerProviderInfo =>
      p !== null &&
      typeof p === 'object' &&
      typeof (p as { addonId?: unknown }).addonId === 'string' &&
      Array.isArray((p as { kinds?: unknown }).kinds),
  )
}

const STATUS_CLASS: Record<UnifiedBrokerStatus, string> = {
  connected: 'bg-success/15 text-success',
  connecting: 'bg-warning/15 text-warning',
  disconnected: 'bg-foreground-subtle/15 text-foreground-subtle',
  'auth-failed': 'bg-danger/15 text-danger',
  unreachable: 'bg-danger/15 text-danger',
  error: 'bg-danger/15 text-danger',
}

export function BrokerStep({ kind, onResolved, onBack }: BrokerStepProps) {
  const { t } = useTranslation()
  // For the Alexa broker kind, default to the interactive login mode so the
  // operator is guided towards the best path first. Other kinds still default
  // to "use existing" (no paste-cookie shortcut to highlight).
  const [mode, setMode] = useState<Mode>(kind === ALEXA_BROKER_KIND ? 'alexa-login' : 'existing')

  // Filter by kind at the source; still narrow + re-filter client-side so a
  // mocked/unfiltered list (or a stale cache) never leaks foreign kinds.
  const listQuery = useBrokerList({ kind })
  const brokers = useMemo(
    () => asBrokerList(listQuery.data).filter((b) => b.kind === kind),
    [listQuery.data, kind],
  )

  // Owning addon for this `kind` — threaded as the create selector.
  const providersQuery = useBrokerListProviders()
  const addonId = useMemo<string | undefined>(() => {
    for (const provider of asProviderList(providersQuery.data)) {
      if (provider.kinds.some((k) => k.kind === kind)) return provider.addonId
    }
    return undefined
  }, [providersQuery.data, kind])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [name, setName] = useState<string>('')

  const add = useBrokerAdd({})

  const handleUseExisting = (): void => {
    if (selectedId) onResolved(selectedId)
  }

  const handleCreate = async (settings: Record<string, unknown>): Promise<void> => {
    if (name.trim().length === 0) return
    // `add.mutateAsync` rejects on failure (surfaced via `add.isError`); a
    // throw from `onResolved` would otherwise propagate too. Wrap the whole
    // body so neither produces an unhandled rejection at the call site.
    const result = await add.mutateAsync({
      kind,
      name: name.trim(),
      settings,
      ...(addonId !== undefined ? { addonId } : {}),
    })
    onResolved(result.id)
  }

  // Switch mode, cleaning stale state from the other path.
  const switchMode = (next: Mode): void => {
    if (next === 'new') {
      // Drop any existing-broker selection so it can't be confused with a
      // fresh create.
      setSelectedId(null)
    } else {
      // Clear a stale `add.isError` banner left over from a failed create.
      add.reset()
    }
    setMode(next)
  }

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 text-[11px] text-foreground-subtle hover:text-foreground"
      >
        <ChevronLeft className="h-3.5 w-3.5" /> {t('common.back')}
      </button>

      {/* Mode toggle ─────────────────────────────────────────────── */}
      <div className="inline-flex rounded-lg border border-border p-0.5 flex-wrap gap-0.5">
        {kind === ALEXA_BROKER_KIND && (
          <button
            type="button"
            onClick={() => switchMode('alexa-login')}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              mode === 'alexa-login'
                ? 'bg-primary text-primary-foreground'
                : 'text-foreground-subtle hover:text-foreground'
            }`}
          >
            {t('integrations.brokerStep.loginInteractively', 'Login interactively')}
          </button>
        )}
        <button
          type="button"
          onClick={() => switchMode('existing')}
          className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
            mode === 'existing'
              ? 'bg-primary text-primary-foreground'
              : 'text-foreground-subtle hover:text-foreground'
          }`}
        >
          {t('integrations.brokerStep.useExisting', 'Use existing')}
        </button>
        <button
          type="button"
          onClick={() => switchMode('new')}
          className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
            mode === 'new'
              ? 'bg-primary text-primary-foreground'
              : 'text-foreground-subtle hover:text-foreground'
          }`}
        >
          {kind === ALEXA_BROKER_KIND
            ? t('integrations.brokerStep.pasteCookie', 'Paste cookie')
            : t('integrations.brokerStep.createNew', 'Create new')}
        </button>
      </div>

      {mode === 'alexa-login' && <AlexaLoginStep onResolved={onResolved} onCancel={onBack} />}

      {mode === 'existing' && (
        <div className="space-y-3">
          {listQuery.isLoading && (
            <div className="flex items-center gap-2 text-xs text-foreground-subtle">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />{' '}
              {t('integrations.brokerStep.loadingBrokers')}
            </div>
          )}
          {listQuery.isError && (
            <div className="rounded border border-danger/30 bg-danger/5 text-danger px-3 py-2 text-[11px]">
              {t('integrations.brokerStep.failedToLoadBrokers', 'Failed to load brokers:')}{' '}
              {listQuery.error instanceof Error
                ? listQuery.error.message
                : t('integrations.brokerStep.unknownError', 'Unknown error')}
            </div>
          )}
          {!listQuery.isLoading && !listQuery.isError && brokers.length === 0 && (
            <div className="rounded-lg border border-border bg-surface px-3 py-6 text-center text-xs text-foreground-subtle">
              <Trans
                i18nKey="integrations.brokerStep.noBrokers"
                values={{
                  mode:
                    kind === ALEXA_BROKER_KIND
                      ? t('integrations.brokerStep.loginInteractively', 'Login interactively')
                      : t('integrations.brokerStep.createNew', 'Create new'),
                }}
                components={{ b: <span className="font-medium text-foreground" /> }}
              />
            </div>
          )}
          <div className="space-y-2">
            {brokers.map((b) => {
              const selected = selectedId === b.id
              return (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => setSelectedId(b.id)}
                  className={`flex w-full items-center justify-between gap-3 rounded-lg border bg-surface p-3 text-left transition-colors ${
                    selected
                      ? 'border-primary ring-1 ring-primary'
                      : 'border-border hover:border-foreground-subtle/30'
                  }`}
                >
                  <span className="text-xs font-semibold text-foreground">{b.name}</span>
                  <span
                    className={`text-[10px] rounded-full px-2 py-0.5 font-medium ${STATUS_CLASS[b.status]}`}
                  >
                    {b.status}
                  </span>
                </button>
              )
            })}
          </div>
          {brokers.length > 0 && (
            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={handleUseExisting}
                disabled={!selectedId}
                className="inline-flex items-center gap-1.5 rounded bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {t('integrations.brokerStep.useThisBroker', 'Use this broker')}
              </button>
            </div>
          )}
        </div>
      )}

      {mode === 'new' && (
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-wide text-foreground-subtle">
              {t('integrations.brokerStep.name', 'Name')}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('integrations.brokerStep.myHomeAssistant', 'My Home Assistant')}
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          {add.isError && (
            <div className="rounded border border-danger/30 bg-danger/5 text-danger px-3 py-2 text-[11px]">
              {add.error instanceof Error ? add.error.message : String(add.error)}
            </div>
          )}
          <BrokerForm
            kind={kind}
            {...(addonId !== undefined ? { addonId } : {})}
            onSubmit={(settings) => {
              void handleCreate(settings).catch(() => {
                /* surfaced via add.isError */
              })
            }}
            onCancel={onBack}
            submitLabel={
              add.isPending
                ? t('integrations.brokerStep.creating', 'Creating…')
                : t('integrations.brokerStep.createBroker', 'Create broker')
            }
            disabled={add.isPending || name.trim().length === 0}
          />
          {name.trim().length === 0 && (
            <p className="text-[10px] text-foreground-subtle">
              {t(
                'integrations.brokerStep.enterANameBeforeCreating',
                'Enter a name before creating.',
              )}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
