/**
 * `AddLocationWizard` — 3-step modal for registering a new
 * `StorageLocation` instance.
 *
 *   Step 1 — Pick provider
 *     Lists every registered `storage-provider`. Source: the
 *     `storage.listProviders()` cap method (added Task 19) which
 *     walks the orchestrator's collection registry. Filters down to
 *     providers that support the *initial* location type passed in
 *     by the Storage page (so the "Add" button on a `backups` group
 *     only shows backups-capable providers).
 *
 *   Step 2 — Provider config
 *     Renders the provider's `configSchema` via `FormBuilder`. The
 *     schema comes through the cap surface as `unknown`; we cast back
 *     to `ConfigUISchema` at consumption (matches the existing
 *     IntegrationWizard pattern).
 *
 *   Step 3 — Name + save
 *     Operator supplies a display name. The wizard auto-derives the
 *     canonical id (`<type>:<slug>`) and lets the operator override.
 *     Writes start only if "Enable immediately" is ticked; there is no
 *     default-location flag.
 *
 * `testConfig` was also added to the cap (probes the provider with
 * the in-progress config without persisting). The wizard surfaces it
 * as a "Test connection" button on Step 2 so credentials can be
 * preflighted before commit.
 */

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  NodePicker,
  useStorageListProviders,
  useStorageUpsertLocation,
  useSystem,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Loader2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ConfigUISchema } from '../../types/config-ui'
import { FormBuilder } from '../form-builder/FormBuilder'
import { buildLocationId } from './location-id'
import { PathBrowser } from './PathBrowser'
import { Trans, useTranslation } from 'react-i18next'

interface ProviderInfo {
  readonly providerId: string
  readonly displayName: string
  readonly configSchema: unknown
  readonly nodeLocal: boolean
}

export interface AddLocationWizardProps {
  /**
   * The declared location id (`StorageLocationDeclaration.id`) the
   * operator clicked "Add" on. Only `multi`-cardinality declarations
   * surface the Add button, so this is always an addable type.
   */
  readonly initialType: string
  readonly onClose: () => void
  readonly onCreated: () => void
}

type WizardStep = 'picker' | 'config' | 'naming'

export function AddLocationWizard({ initialType, onClose, onCreated }: AddLocationWizardProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const trpcClient = useSystem().trpcClient
  const [step, setStep] = useState<WizardStep>('picker')
  const [type, setType] = useState<string>(initialType)
  const [picked, setPicked] = useState<ProviderInfo | null>(null)
  const [config, setConfig] = useState<Record<string, unknown>>({})
  const [displayName, setDisplayName] = useState<string>('')
  const [idOverride, setIdOverride] = useState<string | null>(null)
  // DEFAULT OFF, and it agrees with the orchestrator: a newly created sibling is
  // born inert because registering a disk must not silently start writing to it.
  // The operator opts in here, or later from the locations table.
  const [enableImmediately, setEnableImmediately] = useState<boolean>(false)
  const [selectedNodeId, setSelectedNodeId] = useState<string>('hub')
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null)
  const [testing, setTesting] = useState<boolean>(false)

  // Node-local providers (filesystem) bind to a single cluster node + a path on
  // that node's disk. The path browser writes `config.basePath` immutably.
  const setBasePath = (p: string): void => setConfig((c) => ({ ...c, basePath: p }))
  const basePath = typeof config.basePath === 'string' ? config.basePath : ''

  // The cap declares `configSchema: z.unknown()` so its trpc inference
  // collapses the entire endpoint to `any`. We narrow at the boundary
  // by re-shaping the response into the local `ProviderInfo` type
  // before any other code touches it — keeps the rest of the wizard
  // strictly typed.
  const listProvidersQuery: { data: unknown; isLoading: boolean } = useStorageListProviders()
  const providers = useMemo<readonly ProviderInfo[]>(() => {
    const raw = listProvidersQuery.data
    if (!Array.isArray(raw)) return []
    return raw as readonly ProviderInfo[]
  }, [listProvidersQuery.data])
  const loadingProviders = listProvidersQuery.isLoading

  const upsert = useStorageUpsertLocation({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [['storage', 'listLocations']] })
      onCreated()
    },
  })

  const computedId = useMemo<string>(() => {
    if (idOverride !== null && idOverride.length > 0) return idOverride
    return buildLocationId(type, displayName)
  }, [type, displayName, idOverride])

  const handleTest = async (): Promise<void> => {
    if (!picked) return
    setTesting(true)
    setTestResult(null)
    try {
      // testConfig's input is `any` for the same reason listProviders'
      // output is — the cap surface has `config: z.record(z.string(),
      // z.unknown())`. Pin the call shape inside a typed boundary.
      const callTestConfig: (i: {
        providerId: string
        config: Record<string, unknown>
      }) => Promise<unknown> = (i) => trpcClient.storage.testConfig.query(i)
      const raw = await callTestConfig({ providerId: picked.providerId, config })
      const narrowed = raw as { ok: boolean; error?: string }
      setTestResult(narrowed)
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setTesting(false)
    }
  }

  const handleSave = (): void => {
    if (!picked) return
    upsert.mutate({
      id: computedId,
      type,
      displayName: displayName.trim(),
      providerId: picked.providerId,
      config,
      // Enable writes is the operator's switch, and the only one (D383)
      // and is never offered here.
      enabled: enableImmediately,
      nodeId: picked.nodeLocal ? selectedNodeId : undefined,
    })
  }

  const titles: Record<WizardStep, string> = {
    picker: 'Add Location — Pick provider',
    config: `Add Location — ${picked?.displayName ?? ''}`,
    naming: 'Add Location — Name',
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent width="md" placement="sheet-on-mobile" scroll="body">
        <DialogHeader>
          <DialogTitle>{titles[step]}</DialogTitle>
          <p className="text-xs text-foreground-subtle">
            {t('storage.addLocationWizard.type', 'Type:')} <span className="font-mono">{type}</span>
          </p>
        </DialogHeader>
        <DialogBody>
          {step === 'picker' && (
            <div className="space-y-2">
              {loadingProviders && (
                <div className="text-xs text-foreground-subtle animate-pulse">
                  {t('storage.addLocationWizard.loadingProviders', 'Loading providers…')}
                </div>
              )}
              {!loadingProviders && providers.length === 0 && (
                <div className="rounded border border-border bg-background px-3 py-4 text-center text-xs text-foreground-subtle">
                  <Trans
                    i18nKey="storage.addLocationWizard.noProvider"
                    values={{ type }}
                    components={{ code: <code className="font-mono" /> }}
                  />
                </div>
              )}
              {providers.map((p) => (
                <button
                  key={p.providerId}
                  onClick={() => {
                    setPicked(p)
                    setStep('config')
                  }}
                  className="flex w-full items-center gap-3 rounded-lg border border-border bg-background p-3 text-left hover:border-primary/40 hover:bg-primary/5 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-foreground">{p.displayName}</p>
                    <p className="text-[10px] text-foreground-subtle font-mono mt-0.5 truncate">
                      {p.providerId}
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-foreground-subtle flex-shrink-0" />
                </button>
              ))}
            </div>
          )}

          {step === 'config' && picked && (
            <div className="space-y-3">
              <FormBuilder
                schema={picked.configSchema as ConfigUISchema}
                values={config}
                onChange={setConfig}
              />
              {picked.nodeLocal && (
                <div className="space-y-2">
                  <label className="text-[10px] uppercase tracking-wide text-foreground-subtle">
                    {t('storage.addLocationWizard.node', 'Node')}
                  </label>
                  <NodePicker
                    selectedNodeId={selectedNodeId}
                    onSelect={setSelectedNodeId}
                    alwaysShow
                  />
                  <label className="text-[10px] uppercase tracking-wide text-foreground-subtle">
                    {t('storage.addLocationWizard.path', 'Path')}
                  </label>
                  <PathBrowser nodeId={selectedNodeId} value={basePath} onChange={setBasePath} />
                </div>
              )}
              {testResult && (
                <div
                  className={`rounded border px-3 py-2 text-[11px] ${
                    testResult.ok
                      ? 'border-success/30 bg-success/5 text-success'
                      : 'border-danger/30 bg-danger/5 text-danger'
                  }`}
                >
                  {testResult.ok
                    ? t('storage.addLocationWizard.connectionOk', 'Connection OK.')
                    : t('storage.addLocationWizard.testFailed', 'Test failed: {{value1}}', {
                        value1: testResult.error ?? 'unknown error',
                      })}
                </div>
              )}
              <div className="flex items-center justify-between pt-1">
                <button
                  onClick={() => setStep('picker')}
                  className="rounded px-3 py-1.5 text-xs text-foreground-subtle border border-border hover:text-foreground"
                >
                  {t('common.back', 'Back')}
                </button>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      void handleTest()
                    }}
                    disabled={testing}
                    className="rounded border border-border px-3 py-1.5 text-xs text-foreground hover:bg-primary/10 disabled:opacity-50"
                  >
                    {testing
                      ? t('storage.addLocationWizard.testing', 'Testing…')
                      : t('storage.addLocationWizard.testConnection', 'Test connection')}
                  </button>
                  <button
                    onClick={() => setStep('naming')}
                    className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                  >
                    {t('common.next', 'Next')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {step === 'naming' && picked && (
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wide text-foreground-subtle">
                  {t('storage.addLocationWizard.displayName', 'Display name')}
                </label>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder={t('storage.addLocationWizard.on', '{{type}} on {{displayName}}', {
                    type,
                    displayName: picked.displayName,
                  })}
                  className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wide text-foreground-subtle">
                  {t('storage.addLocationWizard.idLabel')}{' '}
                  <span className="lowercase tracking-normal text-foreground-subtle">
                    {t(
                      'storage.addLocationWizard.autoDerivedOverrideIfNeeded',
                      '— auto-derived; override if needed',
                    )}
                  </span>
                </label>
                <input
                  type="text"
                  value={computedId}
                  onChange={(e) => setIdOverride(e.target.value)}
                  placeholder={buildLocationId(type, displayName)}
                  className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <p className="text-[10px] text-foreground-subtle">
                  {t('storage.addLocationWizard.format', 'Format:')}{' '}
                  <code className="font-mono">
                    {t('storage.addLocationWizard.typeSlug', '<type>:<slug>')}
                  </code>
                  . Lowercase letters, digits, and hyphens only.
                </p>
              </div>
              <label className="flex items-start gap-2 rounded border border-border bg-background px-3 py-2 cursor-pointer hover:bg-primary/5">
                <input
                  type="checkbox"
                  checked={enableImmediately}
                  onChange={(e) => setEnableImmediately(e.target.checked)}
                  className="accent-primary mt-0.5"
                />
                <div className="space-y-0.5">
                  <div className="text-xs font-medium text-foreground">
                    {t('storage.addLocationWizard.enableImmediately', 'Enable immediately')}
                  </div>
                  <div className="text-[10px] text-foreground-subtle">
                    {t(
                      'storage.addLocationWizard.aDisabledLocationReceivesNo',
                      'A disabled location receives no writes until enabled — reads and age-based retention still work, nothing new lands here. Leave this off to register the disk now and start using it later.',
                    )}
                  </div>
                </div>
              </label>
              {upsert.isError && (
                <div className="rounded border border-danger/30 bg-danger/5 text-danger px-3 py-2 text-[11px]">
                  {upsert.error instanceof Error ? upsert.error.message : String(upsert.error)}
                </div>
              )}
              <div className="flex items-center justify-between pt-1">
                <button
                  onClick={() => setStep('config')}
                  className="rounded px-3 py-1.5 text-xs text-foreground-subtle border border-border hover:text-foreground"
                >
                  {t('common.back', 'Back')}
                </button>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      setType(initialType)
                      setPicked(null)
                      setConfig({})
                      setDisplayName('')
                      setIdOverride(null)
                      setEnableImmediately(false)
                      setTestResult(null)
                      setStep('picker')
                    }}
                    className="rounded px-3 py-1.5 text-xs text-foreground-subtle border border-border hover:text-foreground"
                  >
                    {t('common.reset', 'Reset')}
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={upsert.isPending || displayName.trim().length === 0}
                    className="inline-flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    {upsert.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    {upsert.isPending
                      ? t('storage.addLocationWizard.saving', 'Saving…')
                      : t('common.save', 'Save')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
