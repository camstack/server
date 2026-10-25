/**
 * FormBuilder — section layout tests.
 *
 * Verifies that a section whose ONLY field is `type:'widget'` is rendered
 * full-bleed (no grid wrapper) while normal multi-field sections keep the
 * standard `@container` grid.
 *
 * @camstack/ui-library is partially mocked so that:
 *   - `isFieldVisible` keeps its real implementation (needed for the
 *     visibleFieldCount gate in SectionCard).
 *   - `ConfigFormField` is replaced with a lightweight stub that renders a
 *     `<div data-testid="form-field" data-type={field.type} data-key={field.key} />`
 *     so we can assert DOM structure without pulling in WidgetSlot / context
 *     dependencies.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ConfigField, ConfigUISchema } from '@camstack/types'

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    ConfigFormField: ({ field }: { readonly field: ConfigField }) => (
      <div
        data-testid="form-field"
        data-type={field.type}
        data-key={'key' in field ? field.key : ''}
      />
    ),
  }
})

// Import AFTER the mock is declared.
import { FormBuilder } from '../FormBuilder'

const noop = () => {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function widgetSection(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'rec',
        title: 'Recording',
        fields: [
          {
            type: 'widget',
            key: 'rec-panel',
            label: 'Recording Panel',
            widgetId: 'host/recording-panel',
          },
        ],
      },
    ],
  }
}

function twoFieldSection(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'basic',
        title: 'Basic',
        fields: [
          { type: 'text', key: 'name', label: 'Name' },
          { type: 'boolean', key: 'enabled', label: 'Enabled', default: false },
        ],
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FormBuilder › SectionCard', () => {
  it('single-widget section: field is NOT wrapped in a grid div', () => {
    const { container } = render(
      <FormBuilder schema={widgetSection()} values={{}} onChange={noop} />,
    )

    // Find the rendered form-field stub for the widget
    const field = container.querySelector('[data-testid="form-field"][data-type="widget"]')
    expect(field).not.toBeNull()

    // Its immediate parent must NOT carry any of the grid classes
    const parent = field?.parentElement
    expect(parent?.className).not.toMatch(/\bgrid\b/)
    expect(parent?.className).not.toMatch(/grid-cols/)
  })

  it('single-widget section: the section card container (border/padding) is still present', () => {
    const { container } = render(
      <FormBuilder schema={widgetSection()} values={{}} onChange={noop} />,
    )

    // The outer @container div that provides the card chrome must exist
    const card = container.querySelector('.\\@container')
    expect(card).not.toBeNull()
  })

  it('multi-field section: fields are wrapped in the grid div', () => {
    const { container } = render(
      <FormBuilder schema={twoFieldSection()} values={{}} onChange={noop} />,
    )

    const fields = container.querySelectorAll('[data-testid="form-field"]')
    expect(fields.length).toBe(2)

    // Both fields share a common grid parent
    const parent = fields[0]?.parentElement
    expect(parent?.className).toMatch(/\bgrid\b/)
  })

  it('single-widget section: section header is hidden (widget owns its own title)', () => {
    const { queryByText } = render(
      <FormBuilder schema={widgetSection()} values={{}} onChange={noop} />,
    )
    // The section title "Recording" must not appear — the widget is chromeless.
    expect(queryByText('Recording')).toBeNull()
  })
})

describe('FormBuilder › OptionSelect wiring', () => {
  it('renders tags via OptionSelect (creatable combobox)', () => {
    const schema: ConfigUISchema = {
      sections: [
        {
          id: 'tv',
          title: 'TV',
          fields: [
            {
              type: 'tags',
              key: 'channels',
              label: 'Channels',
              suggestions: ['Rai 1', 'Rai 2'],
            },
          ],
        },
      ],
    }
    render(<FormBuilder schema={schema} values={{ channels: ['Rai 1'] }} onChange={noop} />)
    expect(screen.getByTestId('config-tags-channels')).toBeTruthy()
    expect(screen.getByRole('combobox')).toBeTruthy()
    expect(screen.getByText('Rai 1')).toBeTruthy()
  })

  it('renders a large multiselect via OptionSelect', () => {
    const options = Array.from({ length: 8 }, (_, i) => ({
      value: String(i),
      label: `Device ${i}`,
    }))
    const schema: ConfigUISchema = {
      sections: [
        {
          id: 'link',
          title: 'Link',
          fields: [
            {
              type: 'multiselect',
              key: 'devices',
              label: 'Devices',
              options,
            },
          ],
        },
      ],
    }
    render(<FormBuilder schema={schema} values={{ devices: ['0'] }} onChange={noop} />)
    expect(screen.getByTestId('config-multiselect-devices')).toBeTruthy()
    expect(screen.getByRole('combobox')).toBeTruthy()
    expect(screen.getByText('Device 0')).toBeTruthy()
  })

  it('keeps a small closed multiselect on the chip FormField path', () => {
    const schema: ConfigUISchema = {
      sections: [
        {
          id: 'flags',
          title: 'Flags',
          fields: [
            {
              type: 'multiselect',
              key: 'flags',
              label: 'Flags',
              options: [
                { value: 'a', label: 'A' },
                { value: 'b', label: 'B' },
              ],
            },
          ],
        },
      ],
    }
    const { container } = render(
      <FormBuilder schema={schema} values={{ flags: [] }} onChange={noop} />,
    )
    expect(container.querySelector('[data-testid="config-multiselect-flags"]')).toBeNull()
    expect(
      container.querySelector('[data-testid="form-field"][data-type="multiselect"]'),
    ).not.toBeNull()
  })
})

describe('FormBuilder › a section with nothing to show is not drawn', () => {
  const gated = { field: 'mode', equals: 'custom' } as const
  function accordionOfActions(): ConfigUISchema {
    return {
      sections: [
        {
          id: 'mode',
          title: 'Mode',
          fields: [
            {
              type: 'select',
              key: 'mode',
              label: 'Mode',
              options: [],
              default: 'public',
            },
          ],
        },
        {
          id: 'custom-only',
          title: 'Custom only',
          style: 'accordion',
          defaultCollapsed: true,
          fields: [
            {
              type: 'info',
              key: 'i',
              label: 'Info',
              content: 'x',
              showWhen: gated,
            },
            {
              type: 'addon-action-button',
              key: 'b',
              label: 'B',
              addonId: 'a',
              action: 'go',
              buttonLabel: 'Go',
              showWhen: gated,
            },
          ],
        },
      ],
    }
  }

  it('an accordion whose every field is hidden renders no frame and no heading', () => {
    const { container, queryByText } = render(
      <FormBuilder schema={accordionOfActions()} values={{ mode: 'public' }} onChange={noop} />,
    )
    expect(queryByText('Custom only')).toBeNull()
    expect(container.querySelector('[data-settings-section="custom-only"]')).toBeNull()
  })

  it('the same section appears as soon as the gating value flips', () => {
    const { rerender, queryByText } = render(
      <FormBuilder schema={accordionOfActions()} values={{ mode: 'public' }} onChange={noop} />,
    )
    rerender(
      <FormBuilder schema={accordionOfActions()} values={{ mode: 'custom' }} onChange={noop} />,
    )
    expect(queryByText('Custom only')).not.toBeNull()
  })

  it('an accordion drawn without its header is never sealed shut', () => {
    // No title → no header to click; a collapsed body would be an empty frame
    // with its fields unreachable.
    const schema: ConfigUISchema = {
      sections: [
        {
          id: 'headless',
          title: '',
          style: 'accordion',
          defaultCollapsed: true,
          fields: [{ type: 'text', key: 'name', label: 'Name' }],
        },
      ],
    }
    const { container } = render(<FormBuilder schema={schema} values={{}} onChange={noop} />)
    expect(container.querySelector('[data-testid="form-field"][data-key="name"]')).not.toBeNull()
  })
})
