/**
 * `EditLocationModal` — modal for updating an existing
 * `StorageLocation`.
 *
 * Re-uses the wizard's `<FormBuilder>` rendering of the provider's
 * `configSchema`, pre-filled from `location.config`. Save calls
 * `useStorageUpsertLocation` with the same `id` as the existing
 * record — the orchestrator's upsert path overwrites by id.
 *
 * Editable fields:
 *   - Provider config (every field declared by the provider's
 *     `getProviderInfo().configSchema`).
 *   - Display name.
 * Non-editable on this surface (Tasks 19/21 own them):
 *   - The `id` itself — operators rename via delete + add.
 *   - The `type` — type is structural (selects which provider can
 *     back the location); changing it would change the addressable
 *     ref string, breaking every backed-up reference.
 *   - the default — deleted (D383); enable/disable on the card is the
 *     write switch. This modal does not offer it.
 */

import type { StorageLocation } from '@camstack/types'
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  NodePicker,
  useStorageListProviders,
  useStorageUpsertLocation,
  useSystem,
  Input,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ConfigUISchema } from '../../types/config-ui'
import { FormBuilder } from '../form-builder/FormBuilder'
import { toLocationUpsertInput } from './location-enabled'
import { DEFAULT_MIN_FREE_PERCENT } from './location-protection'
import { PathBrowser } from './PathBrowser'
import { ProtectionPolicyField } from './ProtectionPolicyField'
import { Trans, useTranslation } from 'react-i18next'

interface ProviderInfo {
  readonly providerId: string
  readonly displayName: string
  readonly configSchema: unknown
  readonly shouldSaveDiskSpace: boolean
  readonly minFreePercent: number | null
  readonly nodeLocal: boolean
}

export interface EditLocationModalProps {
  readonly location: StorageLocation
  readonly onClose: () => void
  readonly onSaved: () => void
}

export function EditLocationModal({ location, onClose, onSaved }: EditLocationModalProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const trpcClient = useSystem().trpcClient

  const [config, setConfig] = useState<Record<string, unknown>>({ ...location.config })
  const [displayName, setDisplayName] = useState<string>(location.displayName)
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null)
  const [testing, setTesting] = useState<boolean>(false)

  // Same boundary cast as `AddLocationWizard` — the cap surface
  // declares `configSchema: z.unknown()`, defeating tRPC inference.
  const listProvidersQuery: { data: unknown; isLoading: boolean } = useStorageListProviders()
  const provider = useMemo<ProviderInfo | null>(() => {
    const raw = listProvidersQuery.data
    if (!Array.isArray(raw)) return null
    const list = raw as readonly ProviderInfo[]
    return list.find((p) => p.providerId === location.providerId) ?? null
  }, [listProvidersQuery.data, location.providerId])

  const upsert = useStorageUpsertLocation({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [['storage', 'listLocations']] })
      onSaved()
    },
  })

  // `minFreePercent` is an intrinsic disk-space setting of the location's
  // provider (declared via getProviderInfo). Show the field only when the
  // provider manages disk space; its default placeholder is the provider's
  // declared `minFreePercent`.
  const showMinFree = provider?.shouldSaveDiskSpace === true

  // Node-local providers (filesystem) bind to a single cluster node + a path on
  // that node's disk — gate a node picker + path browser when the provider
  // declares `nodeLocal`. The browser writes the chosen path into
  // `config.basePath` immutably.
  const showNode = provider?.nodeLocal === true
  const initialNodeId = typeof location.nodeId === 'string' ? location.nodeId : 'hub'
  const [selectedNodeId, setSelectedNodeId] = useState<string>(initialNodeId)
  const basePath = typeof config.basePath === 'string' ? config.basePath : ''
  const setBasePath = (p: string): void => setConfig((c) => ({ ...c, basePath: p }))

  // ONE protection policy: a unit and a value, writing `minFreePercent` OR
  // `minFreeGb` and clearing the other. The control owns the pending unit —
  // deriving it from the config made every switch snap back (see
  // `ProtectionPolicyField`). A stored `maxUsedGb` is carried through the
  // upsert and shown read-only there; it is not a knob any more.
  const defaultPercent = provider?.minFreePercent ?? DEFAULT_MIN_FREE_PERCENT

  const handleTest = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      const callTestConfig: (i: {
        providerId: string
        locationId: string
        config: Record<string, unknown>
      }) => Promise<unknown> = (i) => trpcClient.storage.testConfig.query(i)
      // `config` still holds the redaction sentinel for every credential the
      // operator did not retype (`listLocations` never sends the real one).
      // `locationId` is what lets the orchestrator resolve those back to the
      // stored values — without it this button reports a working password as
      // an authentication failure. The wizard, which has no stored row, sends
      // no id and its typed values go through untouched.
      const raw = await callTestConfig({
        providerId: location.providerId,
        locationId: location.id,
        config,
      })
      setTestResult(raw as { ok: boolean; error?: string })
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setTesting(false)
    }
  }

  // The whole row, rebuilt from what was read: `upsertLocation` REPLACES, and
  // a field-by-field payload drops `nodeId` (and now the location's state).
  const handleSave = (): void => {
    upsert.mutate(
      toLocationUpsertInput(location, {
        displayName: displayName.trim(),
        config,
        nodeId: showNode ? selectedNodeId : location.nodeId,
      }),
    )
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent width="md" placement="sheet-on-mobile" scroll="body">
        <DialogHeader>
          <DialogTitle>
            {t('storage.editLocationModal.title', { name: location.displayName })}
          </DialogTitle>
          <p className="text-xs text-foreground-subtle">
            <span className="font-mono">{location.id}</span> ·{' '}
            {provider?.displayName ?? location.providerId}
          </p>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-wide text-foreground-subtle">
              {t('storage.editLocationModal.displayName', 'Display name')}
            </label>
            <Input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          {provider && (
            <FormBuilder
              schema={provider.configSchema as ConfigUISchema}
              values={config}
              onChange={setConfig}
            />
          )}
          {showNode && (
            <div className="space-y-2">
              <label className="text-[10px] uppercase tracking-wide text-foreground-subtle">
                {t('storage.editLocationModal.node', 'Node')}
              </label>
              <NodePicker selectedNodeId={selectedNodeId} onSelect={setSelectedNodeId} alwaysShow />
              <label className="text-[10px] uppercase tracking-wide text-foreground-subtle">
                {t('storage.editLocationModal.path', 'Path')}
              </label>
              <PathBrowser nodeId={selectedNodeId} value={basePath} onChange={setBasePath} />
            </div>
          )}
          {showMinFree && (
            <ProtectionPolicyField
              config={config}
              defaultPercent={defaultPercent}
              onChange={setConfig}
            />
          )}
          {!provider && !listProvidersQuery.isLoading && (
            <div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
              <Trans
                i18nKey="storage.editLocationModal.providerGone"
                values={{ id: location.providerId }}
                components={{ code: <code className="font-mono" /> }}
              />
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
                ? t('storage.editLocationModal.connectionOk', 'Connection OK.')
                : t('storage.editLocationModal.testFailed', 'Test failed: {{value1}}', {
                    value1: testResult.error ?? 'unknown error',
                  })}
            </div>
          )}
          {upsert.isError && (
            <div className="rounded border border-danger/30 bg-danger/5 text-danger px-3 py-2 text-[11px]">
              {upsert.error instanceof Error ? upsert.error.message : String(upsert.error)}
            </div>
          )}
        </DialogBody>
        <DialogFooter className="justify-between">
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void handleTest()
              }}
              disabled={testing || !provider}
            >
              {testing
                ? t('storage.editLocationModal.testing', 'Testing…')
                : t('storage.editLocationModal.testConnection', 'Test connection')}
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={upsert.isPending || displayName.trim().length === 0}
            >
              {upsert.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {upsert.isPending
                ? t('storage.editLocationModal.saving', 'Saving…')
                : t('common.save', 'Save')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
