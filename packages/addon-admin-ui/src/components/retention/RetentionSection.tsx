/**
 * System → Data → Retention — every retention knob of the system, derived from the
 * `retention-source` catalog (D1084). An addon that keeps data for a bounded time lists its
 * knobs there; this page hardcodes none. A device may override a device-scoped knob on its
 * own page; here that knob shows the cluster default the device inherits.
 */
import {
  Button,
  EmptyState,
  ErrorBox,
  Input,
  SECTION_BODY,
  SectionCard,
  SettingRow,
  trpc,
} from '@camstack/ui-library'
import type { RetentionKnob } from '@camstack/types'
import { Loader2, Timer } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useCapabilityPresence } from '../../lib/capability-presence'
import { groupKnobs, judgeKnobValue, writeCallFor } from './retention-model'

function KnobRow({ knob }: { readonly knob: RetentionKnob }): ReactNode {
  const { t } = useTranslation()
  const utils = trpc.useUtils()
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const write = trpc.addonSettings.updateScopedSettings.useMutation({
    onSuccess: async () => {
      setDraft(null)
      setError(null)
      await utils.retentionSource.listRetentionKnobs.invalidate()
    },
    onError: (err) => setError(err.message),
  })
  const shown = draft ?? (knob.value === null ? '' : String(knob.value))
  const verdict = draft === null ? null : judgeKnobValue(knob, draft)
  const call = verdict !== null && verdict.ok ? writeCallFor(knob, verdict.value) : null

  const save = (): void => {
    if (call === null || call.method !== 'updateScopedSettings') return
    write.mutate(call.input)
  }

  return (
    <SettingRow label={t(knob.labelKey, knob.label)}>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="number"
          inputMode="numeric"
          className="w-24"
          value={shown}
          min={knob.min}
          max={knob.max}
          aria-label={t(knob.labelKey, knob.label)}
          onChange={(e) => setDraft(e.target.value)}
        />
        <span className="text-foreground-muted text-sm">
          {knob.zeroMeansForever && knob.value === 0
            ? t('retention.forever', 'kept forever')
            : t(`retention.unit.${knob.unit}`, knob.unit)}
        </span>
        {knob.scope === 'device' ? (
          <span className="text-foreground-subtle text-xs">
            {t('retention.deviceOverridable', 'a device can override this')}
          </span>
        ) : null}
        {draft !== null ? (
          <Button size="sm" disabled={call === null || write.isPending} onClick={save}>
            {t('retention.save', 'Save')}
          </Button>
        ) : null}
        {verdict !== null && !verdict.ok ? (
          <span className="text-danger text-xs">
            {t(`retention.invalid.${verdict.reason}`, verdict.reason)}
          </span>
        ) : null}
        {error === null ? null : <span className="text-danger text-xs">{error}</span>}
      </div>
    </SettingRow>
  )
}

export function RetentionSection(): ReactNode {
  const { t } = useTranslation()
  const presence = useCapabilityPresence('retention-source')
  const query = trpc.retentionSource.listRetentionKnobs.useQuery(
    {},
    { enabled: presence === 'present' },
  )

  if (presence === 'pending' || (presence === 'present' && query.isLoading)) {
    return (
      <div className="text-foreground-muted flex items-center gap-2 p-4 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('retention.loading', 'Loading retention…')}
      </div>
    )
  }
  if (presence === 'unknown' || query.isError) {
    return (
      <ErrorBox
        title={t('retention.errorTitle', 'Could not read the retention settings')}
        message={t('retention.errorBody', 'The hub did not answer. Try again in a moment.')}
      />
    )
  }
  if (presence === 'absent' || query.data === undefined || query.data.length === 0) {
    return (
      <EmptyState
        icon={Timer}
        title={t('retention.emptyTitle', 'No retention settings')}
        description={t('retention.emptyBody', 'No addon lists how long it keeps data.')}
      />
    )
  }
  return (
    <div className="flex flex-col gap-3">
      {groupKnobs(query.data).map((g) => (
        <SectionCard
          key={g.group}
          headingId={`retention-${g.group}`}
          title={t(`retention.group.${g.group}`, g.group)}
          icon={Timer}
        >
          <div className={SECTION_BODY}>
            {g.knobs.map((k) => (
              <KnobRow key={k.id} knob={k} />
            ))}
          </div>
        </SectionCard>
      ))}
    </div>
  )
}
