/**
 * Launch settings of ONE node — the heap ceiling and (hub only) hub-main's RSS
 * budget, persisted on the node (`launch-overrides.json`) and read at its next
 * launch (ADR 0970). Reads `getLaunchOverrides`, writes `setLaunchOverrides`
 * through the standard singleton `nodeId` routing: the hub is the unpinned
 * default provider, an agent is pinned.
 */
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Input,
  SettingRow,
  useServerManagementGetLaunchOverrides,
  useServerManagementSetLaunchOverrides,
} from '@camstack/ui-library'

const MIN_MB = 512
const MAX_MB = 65536
const QUERY_KEY = [['serverManagement', 'getLaunchOverrides']] as const

export interface LaunchSettingsNode {
  readonly id: string
  readonly isHub: boolean
  readonly isOnline: boolean
}

/** `''` clears (null); an integer in range is the value; anything else is `undefined` (invalid). */
function parseMb(raw: string): number | null | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (!/^[0-9]+$/.test(trimmed)) return undefined
  const value = Number(trimmed)
  return value >= MIN_MB && value <= MAX_MB ? value : undefined
}

const toText = (value: number | null | undefined): string => (value == null ? '' : String(value))

export function NodeLaunchSettingsCard({ node }: { readonly node: LaunchSettingsNode }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const routingInput = node.isHub ? undefined : { nodeId: node.id }
  const query = useServerManagementGetLaunchOverrides(routingInput, {
    enabled: node.isOnline,
    retry: 1,
  })
  const save = useServerManagementSetLaunchOverrides({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY })
    },
  })
  const [heap, setHeap] = useState('')
  const [rss, setRss] = useState('')
  const [message, setMessage] = useState<string | null>(null)

  const stored = query.data
  useEffect(() => {
    if (stored === undefined) return
    setHeap(toText(stored.heapMb))
    setRss(toText(stored.rssBudgetMb))
  }, [stored])

  const handleSave = async (): Promise<void> => {
    const heapMb = parseMb(heap)
    const rssBudgetMb = node.isHub ? parseMb(rss) : null
    if (heapMb === undefined || rssBudgetMb === undefined) {
      setMessage(
        t(
          'nodes.launch.invalid',
          'Enter a whole number between {{min}} and {{max}} MB, or leave the field empty.',
          { min: MIN_MB, max: MAX_MB },
        ),
      )
      return
    }
    setMessage(null)
    try {
      const result = await save.mutateAsync({
        ...routingInput,
        heapMb,
        ...(node.isHub ? { rssBudgetMb } : {}),
      })
      setMessage(
        result.restartRequired
          ? t('nodes.launch.saved', 'Saved. Takes effect on restart.')
          : t('nodes.launch.savedNow', 'Saved.'),
      )
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('nodes.launch.failed', 'Save failed.'))
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface/40 divide-y divide-border px-3">
      <SettingRow label={t('nodes.launch.heap', 'Heap ceiling (MB)')}>
        <Input
          type="number"
          inputMode="numeric"
          aria-label={t('nodes.launch.heap', 'Heap ceiling (MB)')}
          placeholder={t('nodes.launch.default', 'Default')}
          value={heap}
          onChange={(event) => setHeap(event.target.value)}
          disabled={!node.isOnline || query.isLoading}
        />
      </SettingRow>
      {node.isHub && (
        <SettingRow label={t('nodes.launch.rss', 'RSS budget (MB)')}>
          <Input
            type="number"
            inputMode="numeric"
            aria-label={t('nodes.launch.rss', 'RSS budget (MB)')}
            placeholder={t('nodes.launch.default', 'Default')}
            value={rss}
            onChange={(event) => setRss(event.target.value)}
            disabled={!node.isOnline || query.isLoading}
          />
        </SettingRow>
      )}
      <SettingRow
        label={t('nodes.launch.restartNote', 'Takes effect on restart')}
        actions={
          <Button
            type="button"
            size="sm"
            onClick={() => void handleSave()}
            disabled={!node.isOnline || save.isPending}
          >
            {t('common.save', 'Save')}
          </Button>
        }
      >
        {message ?? ''}
      </SettingRow>
    </div>
  )
}
