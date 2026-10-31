/**
 * Step selector — the model→step link as a SELECTION over the real pipeline
 * step ids (from `pipelineExecutor.getSchema`), never a free-text field. A
 * typo'd step id used to register a model into a bucket no step reads
 * (`groupCustomModelsByStep` buckets by exact id) with no error anywhere.
 */
import { useEffect, useState } from 'react'
import type { AddonPageProps } from '@camstack/ui-library'
import { listStepOptions } from '../ui/api.js'
import type { StepOption } from '../ui/model-studio-ui.js'
import { Field } from './Form.js'
import { useT } from '../i18n/index.js'
import { Select } from '@camstack/ui-library'

interface StepSelectProps {
  readonly trpc: AddonPageProps['trpc']
  readonly label?: string
  readonly value: string
  readonly onChange: (stepId: string) => void
  /** Restrict the offer to these slots (e.g. `['detector']` for plus catalog imports). */
  readonly slots?: readonly string[]
}

export function StepSelect({ trpc, label, value, onChange, slots }: StepSelectProps) {
  const { t } = useT()
  const [options, setOptions] = useState<readonly StepOption[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    listStepOptions(trpc)
      .then((all) => {
        if (cancelled) return
        const filtered = slots ? all.filter((o) => slots.includes(o.slot)) : all
        setOptions(filtered)
        setError(null)
        // Snap an out-of-list value onto the first real option so the form
        // can never submit a step id the pipeline does not have.
        if (filtered.length > 0 && !filtered.some((o) => o.id === value)) {
          onChange(filtered[0]!.id)
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setOptions([])
        setError(err instanceof Error ? err.message : t('stepSelect.loadFailed'))
      })
    return () => {
      cancelled = true
    }
    // `slots` is expected to be a stable literal per call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trpc])

  return (
    <Field label={label ?? t('common.step')}>
      <Select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={options === null || options.length === 0}
        className="w-full"
      >
        {options === null && <option value={value}>{t('stepSelect.loading')}</option>}
        {options !== null && options.length === 0 && (
          <option value={value}>{t('stepSelect.none')}</option>
        )}
        {options?.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name} · {o.id}
          </option>
        ))}
      </Select>
      {error && <span className="block text-[10px] text-danger pt-0.5">{error}</span>}
    </Field>
  )
}
