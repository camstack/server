/**
 * Settings form for a script that exported `settingsSchema`.
 *
 * Values live in `coreBlocks.getBlockSettings` / `updateBlockSettings` — the
 * same ConfigUISchema + FormBuilder path addons use. Absent schema ⇒ null UI
 * (the script has not declared a form yet).
 *
 * Button actions the schema may declare (stamp + restart so the running
 * script observes them):
 *   - `refresh-channel-catalog` — TV channel scrape suggestions
 *   - `send-tv-schedule-now` — TV schedule deliver now
 *   - `refresh-nordvpn-catalog` — NordVPN Italy WireGuard stations
 *   - `probe-nordvpn-italy` — TCP-probe Italy stations (no UniFi mutation)
 *   - `test-nordvpn-endpoint` — apply + probe one selected station on UniFi
 *   - `refresh-unifi-catalog` — traffic routes / VPN clients / LAN / gateways
 */

import type { ConfigUISchemaWithValues } from '@camstack/types'
import {
  Button,
  useCoreBlocksGet,
  useCoreBlocksGetBlockSettings,
  useCoreBlocksRestart,
  useCoreBlocksSetEnabled,
  useCoreBlocksUpdateBlockSettings,
  useSystem,
} from '@camstack/ui-library'
import { Loader2 } from 'lucide-react'
import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { FormBuilder } from '../../components/form-builder/FormBuilder'
import { Trans, useTranslation } from 'react-i18next'
import i18n from '../../i18n/index'

export interface ScriptSettingsPanelProps {
  readonly blockId: string
}

type ScriptStampAction =
  | 'refresh-channel-catalog'
  | 'send-tv-schedule-now'
  | 'refresh-nordvpn-catalog'
  | 'probe-nordvpn-italy'
  | 'test-nordvpn-endpoint'
  | 'refresh-unifi-catalog'

function isScriptStampAction(action: string): action is ScriptStampAction {
  return (
    action === 'refresh-channel-catalog' ||
    action === 'send-tv-schedule-now' ||
    action === 'refresh-nordvpn-catalog' ||
    action === 'probe-nordvpn-italy' ||
    action === 'test-nordvpn-endpoint' ||
    action === 'refresh-unifi-catalog'
  )
}

function stampPatchFor(action: ScriptStampAction): Record<string, number> {
  const now = Date.now()
  switch (action) {
    case 'refresh-channel-catalog':
      return { channelCatalogRefreshAt: now }
    case 'send-tv-schedule-now':
      return { sendNowAt: now }
    case 'refresh-nordvpn-catalog':
      return { nordVpnCatalogRefreshAt: now }
    case 'probe-nordvpn-italy':
      return { nordVpnProbeAt: now }
    case 'test-nordvpn-endpoint':
      return { nordVpnTestAt: now }
    case 'refresh-unifi-catalog':
      return { unifiCatalogRefreshAt: now }
  }
}

function enableInfoFor(action: ScriptStampAction): string {
  switch (action) {
    case 'refresh-channel-catalog':
      return i18n.t('build.scriptSettingsPanel.enableChannel')
    case 'send-tv-schedule-now':
      return i18n.t('build.scriptSettingsPanel.enableTv')
    case 'refresh-nordvpn-catalog':
      return i18n.t('build.scriptSettingsPanel.enableNord')
    case 'probe-nordvpn-italy':
      return i18n.t('build.scriptSettingsPanel.enableItaly')
    case 'test-nordvpn-endpoint':
      return i18n.t('build.scriptSettingsPanel.enableVpn')
    case 'refresh-unifi-catalog':
      return i18n.t('build.scriptSettingsPanel.enableUnifi')
  }
}

function fieldKey(field: unknown): string | null {
  if (field === null || typeof field !== 'object' || !('key' in field)) return null
  const key = Reflect.get(field, 'key')
  return typeof key === 'string' ? key : null
}

function fieldValue(field: unknown): unknown {
  if (field === null || typeof field !== 'object' || !('value' in field)) return undefined
  return Reflect.get(field, 'value')
}

function extractValues(schema: ConfigUISchemaWithValues): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const section of schema.sections) {
    for (const field of section.fields) {
      const key = fieldKey(field)
      if (key !== null) out[key] = fieldValue(field)
    }
  }
  return out
}

function isHydrated(value: unknown): value is ConfigUISchemaWithValues {
  if (value === null || typeof value !== 'object') return false
  return Array.isArray(Reflect.get(value, 'sections'))
}

export function ScriptSettingsPanel({ blockId }: ScriptSettingsPanelProps): ReactNode {
  const { t } = useTranslation()
  const system = useSystem()
  const blockQuery = useCoreBlocksGet({ blockId }, { retry: false })
  const settingsQuery = useCoreBlocksGetBlockSettings(
    { blockId },
    { refetchInterval: 10_000, retry: false },
  )
  const update = useCoreBlocksUpdateBlockSettings({
    onSuccess: () => {
      void settingsQuery.refetch()
    },
  })
  const restart = useCoreBlocksRestart()
  const setEnabled = useCoreBlocksSetEnabled()
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState(false)

  const hydrated = isHydrated(settingsQuery.data) ? settingsQuery.data : null
  const baseValues = useMemo(() => (hydrated !== null ? extractValues(hydrated) : {}), [hydrated])
  const values = draft ?? baseValues

  const onChange = useCallback((next: Record<string, unknown>): void => {
    setDraft(next)
  }, [])

  const dirty = draft !== null
  const save = useCallback((): void => {
    if (draft === null) return
    setError(null)
    update.mutate(
      { blockId, patch: draft },
      {
        onSuccess: () => setDraft(null),
        onError: (err) => setError(err instanceof Error ? err.message : String(err)),
      },
    )
  }, [blockId, draft, update])

  const onAction = useCallback(
    async (action: string, _key: string): Promise<unknown> => {
      if (!isScriptStampAction(action)) return undefined
      setActionBusy(true)
      setError(null)
      setInfo(null)
      try {
        // Persist any unsaved draft first so Test uses the selected endpoint
        // and Refresh sees the latest limit / toggles.
        if (draft !== null) {
          await system.trpcClient.coreBlocks.updateBlockSettings.mutate({
            blockId,
            patch: draft,
          })
          setDraft(null)
        }
        await system.trpcClient.coreBlocks.updateBlockSettings.mutate({
          blockId,
          patch: stampPatchFor(action),
        })
        const enabled = blockQuery.data?.block?.enabled === true
        if (!enabled) {
          await setEnabled.mutateAsync({ blockId, enabled: true })
          setInfo(enableInfoFor(action))
        }
        await restart.mutateAsync({ blockId })
        await settingsQuery.refetch()
        if (action === 'send-tv-schedule-now') {
          setInfo('Sending tonight’s schedule now…')
        } else if (action === 'probe-nordvpn-italy') {
          setInfo('Probing NordVPN Italy stations (no UniFi change)…')
        } else if (action === 'test-nordvpn-endpoint') {
          setInfo('Testing VPN endpoint on UniFi…')
        } else if (action === 'refresh-nordvpn-catalog') {
          setInfo('Refreshing NordVPN Italy catalog…')
        } else if (action === 'refresh-unifi-catalog') {
          setInfo('Refreshing UniFi ID catalogs…')
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setActionBusy(false)
      }
      return undefined
    },
    [
      blockId,
      blockQuery.data?.block?.enabled,
      draft,
      restart,
      setEnabled,
      settingsQuery,
      system.trpcClient.coreBlocks,
    ],
  )

  if (settingsQuery.isLoading) {
    return (
      <p className="flex items-center gap-2 text-xs text-foreground-subtle">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('build.scriptSettingsPanel.loading')}
      </p>
    )
  }

  if (settingsQuery.isError) {
    return (
      <p className="text-xs text-danger" data-testid="script-settings-error">
        {t('build.scriptSettingsPanel.couldNotLoadSettings', 'Could not load settings:')}{' '}
        {settingsQuery.error instanceof Error
          ? settingsQuery.error.message
          : String(settingsQuery.error)}
      </p>
    )
  }

  // Null means "no settingsSchema known yet" — not a failed read (D315).
  if (hydrated === null) {
    return null
  }

  return (
    <section
      className="space-y-3 rounded border border-border p-3"
      data-testid="script-settings-panel"
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-medium">
            {t('build.scriptSettingsPanel.settings', 'Settings')}
          </h4>
          <p className="text-xs text-foreground-subtle">
            <Trans i18nKey="build.scriptSettingsPanel.declaredBy" components={{ code: <code /> }} />
          </p>
        </div>
        <Button
          size="sm"
          variant="primary"
          onClick={save}
          disabled={!dirty || update.isPending || actionBusy}
        >
          {update.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t('build.scriptSettingsPanel.saveSettings', 'Save settings')}
        </Button>
      </div>
      <FormBuilder schema={hydrated} values={values} onChange={onChange} onAction={onAction} />
      {error !== null ? (
        <p className="text-xs text-danger" data-testid="script-settings-save-error">
          {error}
        </p>
      ) : null}
      {info !== null ? (
        <p className="text-xs text-foreground-subtle" data-testid="script-settings-info">
          {info}
        </p>
      ) : null}
    </section>
  )
}
