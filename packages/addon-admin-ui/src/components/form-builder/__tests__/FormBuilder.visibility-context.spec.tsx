/**
 * Config -> Motion: the frame-diff analyzer's tuning shows exactly when the
 * analyzer is one of the camera's motion sources.
 *
 * Every knob of the `motion-wasm-settings` section is gated on
 * `{ field: 'motionSources', includes: 'analyzer' }`, but `motionSources`
 * belongs to Detection pipeline, not to this section's form. A form that only
 * knows its own values reads the absent key as "not selected", so the whole
 * section collapsed on every camera -- including those whose analyzer IS the
 * motion source. `visibilityContext` carries the other tab's values for
 * `showWhen` only.
 *
 * Disarm: stop merging `visibilityContext` into `renderedValues` in
 * FormBuilder -- the "analyzer is a source" case fails.
 */
import type { ConfigUISchema } from '@camstack/types'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    ConfigFormField: ({ field }: { readonly field: { readonly key?: string } }) => (
      <div data-testid="form-field" data-key={field.key ?? ''} />
    ),
  }
})

import { FormBuilder } from '../FormBuilder'

const noop = () => {}

const GATE = { field: 'motionSources', includes: 'analyzer' } as const

const motionSection: ConfigUISchema = {
  sections: [
    {
      id: 'motion-wasm-settings',
      title: '',
      fields: [
        { type: 'slider', key: 'threshold', label: 'Threshold', min: 1, max: 255, showWhen: GATE },
        { type: 'number', key: 'minArea', label: 'Min Area', showWhen: GATE },
      ],
    },
  ],
}

const shownKeys = (): string[] =>
  screen.queryAllByTestId('form-field').map((el) => el.getAttribute('data-key') ?? '')

describe('FormBuilder.visibilityContext', () => {
  it('shows the analyzer knobs when another tab says the analyzer is a motion source', () => {
    render(
      <FormBuilder
        schema={motionSection}
        values={{}}
        onChange={noop}
        visibilityContext={{ motionSources: ['onboard', 'analyzer'] }}
      />,
    )
    expect(shownKeys()).toEqual(['threshold', 'minArea'])
  })

  it('hides them when the analyzer is not a motion source', () => {
    render(
      <FormBuilder
        schema={motionSection}
        values={{}}
        onChange={noop}
        visibilityContext={{ motionSources: ['onboard'] }}
      />,
    )
    expect(shownKeys()).toEqual([])
  })

  it('hides them when nothing says (an absent key is not a selection)', () => {
    render(<FormBuilder schema={motionSection} values={{}} onChange={noop} />)
    expect(shownKeys()).toEqual([])
  })
})
