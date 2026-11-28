import { describe, expect, it } from 'vitest'
import { findRawDurationInputs } from '../check-no-raw-duration-input'

const REL = 'packages/addon-admin-ui/src/pages/x/Field.tsx'
const find = (content: string, rel = REL) => findRawDurationInputs([{ rel, content }])

describe('check-no-raw-duration-input', () => {
  it('refuses a retired duration component, by import or by use', () => {
    expect(find("import { DurationPartsInput } from '@dominevo/ui-library'\n")).toHaveLength(1)
    expect(find('<DelayField value={1} />')[0]?.kind).toBe('retired-component')
    expect(find('const labels = useDurationLabels()')).toHaveLength(1)
  })

  it('refuses a number input whose label, id or name says it is a duration', () => {
    expect(find('<Input type="number" aria-label="Timeout (seconds)" />')[0]?.kind).toBe(
      'number-input',
    )
    expect(find('<input\n  type="number"\n  id="retry-interval"\n/>')).toHaveLength(1)
    expect(find('<DraftNumberInput label="Cooldown minutes" />')).toHaveLength(1)
  })

  it('lets a count, a text input and a DurationInput through', () => {
    expect(find('<Input type="number" aria-label="Retries" />')).toEqual([])
    expect(find('<Input type="text" aria-label="Timeout seconds" />')).toEqual([])
    expect(find('<DurationInput aria-label="Timeout" value={1} onChange={f} />')).toEqual([])
  })

  it('honours the marker, comments, the component itself and the scheduler phase', () => {
    expect(
      find(
        '{/* duration-input-ok: a sun offset */}\n<Input type="number" aria-label="Offset minutes" />',
      ),
    ).toEqual([])
    expect(find(' * the old DurationPartsInput did this')).toEqual([])
    expect(
      find(
        '<input type="number" aria-label="Seconds" />',
        'packages/ui-library/src/composites/duration-input/DurationInput.tsx',
      ),
    ).toEqual([])
    expect(
      find(
        '<Input type="number" aria-label="Grace minutes" />',
        'packages/addon-admin-ui/src/pages/build/schedulers/PointEditor.tsx',
      ),
    ).toEqual([])
  })
})
