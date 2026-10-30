/**
 * The extra networks every scan covers besides the hub's own. The list is a
 * cluster setting held by `local-network`; this editor only adds and removes
 * entries, a rescan picks them up server-side.
 */
import {
  Button,
  Input,
  SelectedChip,
  TEXT_SECTION_LABEL,
  useLocalNetworkGetScanSubnets,
  useLocalNetworkSetScanSubnets,
} from '@camstack/ui-library'
import { Plus } from 'lucide-react'
import { type ReactElement, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { checkSubnet } from './scan-subnet'

export function ScanSubnetEditor(): ReactElement {
  const { t } = useTranslation()
  const query = useLocalNetworkGetScanSubnets()
  const save = useLocalNetworkSetScanSubnets({
    onSuccess: () => void query.refetch(),
  })
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const subnets = query.data?.subnets ?? []

  const persist = async (next: readonly string[]): Promise<boolean> => {
    try {
      await save.mutateAsync({ subnets: [...next] })
      return true
    } catch {
      setError(
        t(
          'integrations.scanNetworkModal.subnets.saveFailed',
          'The network list could not be saved.',
        ),
      )
      return false
    }
  }

  const add = async (): Promise<void> => {
    const checked = checkSubnet(draft)
    if (!checked.ok) {
      setError(
        checked.reason === 'prefix'
          ? t(
              'integrations.scanNetworkModal.subnets.errorPrefix',
              'A network larger than a /22 cannot be scanned.',
            )
          : t(
              'integrations.scanNetworkModal.subnets.errorFormat',
              'Enter a network like 192.0.2.0/24.',
            ),
      )
      return
    }
    if (subnets.includes(checked.cidr)) {
      setError(t('integrations.scanNetworkModal.subnets.errorDuplicate', 'Already in the list.'))
      return
    }
    setError(null)
    if (await persist([...subnets, checked.cidr])) setDraft('')
  }

  return (
    <section className="space-y-2" data-testid="scan-subnets">
      <h3 className={TEXT_SECTION_LABEL}>
        {t('integrations.scanNetworkModal.subnets.title', 'Extra networks to scan')}
      </h3>
      <p className="text-xs text-foreground-muted">
        {subnets.length === 0
          ? t(
              'integrations.scanNetworkModal.subnets.none',
              "Only this hub's own networks are scanned.",
            )
          : t(
              'integrations.scanNetworkModal.subnets.hint',
              "Every scan covers this hub's own networks and these.",
            )}
      </p>
      {subnets.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {subnets.map((cidr) => (
            <SelectedChip
              key={cidr}
              label={cidr}
              testId={`scan-subnet-${cidr}`}
              onRemove={() => void persist(subnets.filter((s) => s !== cidr))}
            />
          ))}
        </div>
      )}
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <Input
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              setError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void add()
            }}
            placeholder="192.0.2.0/24"
            state={error === null ? 'default' : 'error'}
            aria-label={t('integrations.scanNetworkModal.subnets.title', 'Extra networks to scan')}
            data-testid="scan-subnet-input"
          />
          {error !== null && <p className="mt-1 text-xs text-danger">{error}</p>}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void add()}
          disabled={save.isPending || draft.trim().length === 0}
          data-testid="scan-subnet-add"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('integrations.scanNetworkModal.subnets.add', 'Add network')}
        </Button>
      </div>
    </section>
  )
}
