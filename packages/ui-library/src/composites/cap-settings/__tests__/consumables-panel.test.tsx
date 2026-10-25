// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ConsumablesStatus } from '@camstack/types'
import { ConsumablesPanel, consumablesOpenStorageKey } from '../ConsumablesPanel'

const reset = vi.fn<(input: { key: string }) => Promise<void>>().mockResolvedValue(undefined)

interface MockCapResult {
  cap: { reset: typeof reset } | undefined
  slice: ConsumablesStatus | undefined
  available: boolean
}
let mockResult: MockCapResult

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => mockResult,
}))
vi.mock('../../../contexts/system-context', () => ({
  useSystem: () => ({ trpcClient: {} }),
}))

function status(items: ConsumablesStatus['items']): ConsumablesStatus {
  return { items, lastChangedAt: 0 }
}

beforeEach(() => {
  reset.mockClear()
  mockResult = { cap: { reset }, slice: status([]), available: true }
  localStorage.clear()
  // The row-level specs below read the EXPANDED body: device 1 carries a
  // remembered "open" choice. The collapse rule itself is pinned on device 7.
  localStorage.setItem(consumablesOpenStorageKey(1), 'open')
})

describe('ConsumablesPanel', () => {
  it('renders a fill bar + percentage when level is known', () => {
    mockResult.slice = status([
      {
        key: 'filter',
        label: 'Filter',
        level: 60,
        status: null,
        lastResetAt: null,
        resettable: false,
      },
    ])
    render(<ConsumablesPanel deviceId={1} />)
    expect(screen.getByText('Filter')).toBeTruthy()
    expect(screen.getByText('60%')).toBeTruthy()
  })

  it('renders a status pill when only status is known', () => {
    mockResult.slice = status([
      {
        key: 'brush',
        label: 'Brush',
        level: null,
        status: 'ok',
        lastResetAt: null,
        resettable: false,
      },
    ])
    render(<ConsumablesPanel deviceId={1} />)
    expect(screen.getByText('OK')).toBeTruthy()
  })

  it('renders an Unknown level badge — never OK — when both level and status are null', () => {
    mockResult.slice = status([
      {
        key: 'x',
        label: 'Mystery',
        level: null,
        status: null,
        lastResetAt: null,
        resettable: false,
      },
    ])
    render(<ConsumablesPanel deviceId={1} />)
    expect(screen.getByText('Unknown').getAttribute('data-level')).toBe('unknown')
  })

  it('shows a Replaced button only when resettable and calls reset({ key })', async () => {
    mockResult.slice = status([
      {
        key: 'main-brush',
        label: 'Main Brush',
        level: 90,
        status: null,
        lastResetAt: null,
        resettable: true,
      },
    ])
    render(<ConsumablesPanel deviceId={1} />)
    const btn = screen.getByRole('button', { name: 'Replaced' })
    fireEvent.click(btn)
    await waitFor(() => expect(reset).toHaveBeenCalledWith({ key: 'main-brush' }))
  })

  it('hides the Replaced button when not resettable', () => {
    mockResult.slice = status([
      {
        key: 'filter',
        label: 'Filter',
        level: 90,
        status: null,
        lastResetAt: null,
        resettable: false,
      },
    ])
    render(<ConsumablesPanel deviceId={1} />)
    expect(screen.queryByRole('button', { name: 'Replaced' })).toBeNull()
  })

  it('renders a placeholder when items is empty', () => {
    mockResult.slice = status([])
    render(<ConsumablesPanel deviceId={1} />)
    expect(screen.getByText('No consumables reported.')).toBeTruthy()
  })

  it('a slice that has not landed is a loading line — never "none reported" (D315)', () => {
    mockResult = { cap: { reset }, slice: undefined, available: false }
    render(<ConsumablesPanel deviceId={1} />)
    expect(screen.queryByText('No consumables reported.')).toBeNull()
    expect(screen.getByTestId('consumables-loading')).toBeTruthy()
  })

  it('a full waste tank reads Full in the warning tone; a low supply reads Low (D915)', () => {
    mockResult.slice = status([
      {
        key: 'dustBin',
        label: 'Dust bin',
        level: null,
        status: 'full',
        kind: 'waste',
        lastResetAt: null,
        resettable: false,
      },
      {
        key: 'salt',
        label: 'Salt',
        level: null,
        status: 'low',
        kind: 'supply',
        lastResetAt: null,
        resettable: false,
      },
    ])
    render(<ConsumablesPanel deviceId={1} />)
    expect(screen.getByText('Full').getAttribute('data-level')).toBe('full')
    // Salt is a supply PRODUCT: its low level is worded as a refill.
    expect(screen.getByText('Refill soon').getAttribute('data-level')).toBe('low')
    expect(screen.getByText('Dust bin').className).toContain('text-warning')
    expect(screen.queryByRole('button', { name: 'Replaced' })).toBeNull()
  })

  it('applies a warning tint for a replace status item', () => {
    mockResult.slice = status([
      {
        key: 'brush',
        label: 'Brush',
        level: null,
        status: 'replace',
        lastResetAt: null,
        resettable: false,
      },
    ])
    const { container } = render(<ConsumablesPanel deviceId={1} />)
    expect(container.querySelector('.border-warning\\/40')).toBeTruthy()
    expect(screen.getByText('Replace')).toBeTruthy()
  })

  it('applies a warning tint for a low level item', () => {
    mockResult.slice = status([
      {
        key: 'filter',
        label: 'Filter',
        level: 10,
        status: null,
        lastResetAt: null,
        resettable: false,
      },
    ])
    const { container } = render(<ConsumablesPanel deviceId={1} />)
    expect(container.querySelector('.border-warning\\/40')).toBeTruthy()
  })

  it('renders "0 days" and the Replace badge for a zero remaining value', () => {
    mockResult.slice = status([
      {
        key: 'tank',
        label: 'Tank',
        level: null,
        status: 'replace',
        lastResetAt: null,
        resettable: false,
        remaining: { value: 0, unit: 'days' },
      },
    ])
    render(<ConsumablesPanel deviceId={1} />)
    expect(screen.getByText('0 days')).toBeTruthy()
    expect(screen.getByText('Replace')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Replaced' })).toBeNull()
  })

  it('renders an em-dash — never "0" — for a null remaining value (D393)', () => {
    mockResult.slice = status([
      {
        key: 'tank',
        label: 'Tank',
        level: null,
        status: 'ok',
        lastResetAt: null,
        resettable: false,
        remaining: { value: null, unit: 'days' },
      },
    ])
    render(<ConsumablesPanel deviceId={1} />)
    expect(screen.getByText('OK')).toBeTruthy()
    expect(screen.getByText('—')).toBeTruthy()
    expect(screen.queryByText('0')).toBeNull()
    expect(screen.queryByText('0 days')).toBeNull()
  })

  it('renders exactly as before for an item without remaining (Dreame etc.)', () => {
    mockResult.slice = status([
      {
        key: 'main-brush',
        label: 'Main Brush',
        level: 60,
        status: null,
        lastResetAt: null,
        resettable: true,
      },
    ])
    render(<ConsumablesPanel deviceId={1} />)
    expect(screen.getByText('60%')).toBeTruthy()
    expect(screen.queryByText(/day|hour|cycle/)).toBeNull()
  })

  it('disables the Replaced button when the cap is unavailable', () => {
    mockResult = {
      cap: { reset },
      slice: status([
        {
          key: 'main-brush',
          label: 'Main Brush',
          level: 90,
          status: null,
          lastResetAt: null,
          resettable: true,
        },
      ]),
      available: false,
    }
    render(<ConsumablesPanel deviceId={1} />)
    const btn = screen.getByRole('button', { name: 'Replaced' })
    expect(btn.hasAttribute('disabled')).toBe(true)
  })
})

describe('ConsumablesPanel — the smart collapse (D915)', () => {
  const OK_ITEMS: ConsumablesStatus['items'] = [
    {
      key: 'salt',
      label: 'Salt',
      level: null,
      status: 'ok',
      kind: 'supply',
      lastResetAt: null,
      resettable: false,
    },
    {
      key: 'filter',
      label: 'Filter',
      level: 80,
      status: null,
      lastResetAt: null,
      resettable: false,
    },
  ]
  const LOW_SALT: ConsumablesStatus['items'] = [
    {
      key: 'salt',
      label: 'Salt',
      level: null,
      status: 'low',
      kind: 'supply',
      lastResetAt: null,
      resettable: false,
    },
    {
      key: 'rinse',
      label: 'Rinse aid',
      level: null,
      status: 'ok',
      kind: 'supply',
      lastResetAt: null,
      resettable: false,
    },
  ]

  it('all ok → collapsed, the header says "All OK" and no row is drawn', () => {
    mockResult.slice = status(OK_ITEMS)
    render(<ConsumablesPanel deviceId={7} />)
    expect(screen.getByText('All OK')).toBeTruthy()
    expect(screen.queryByText('80%')).toBeNull()
    expect(screen.getByRole('button', { expanded: false })).toBeTruthy()
  })

  it('an item needing attention → expanded, every row drawn, no summary line', () => {
    mockResult.slice = status(LOW_SALT)
    render(<ConsumablesPanel deviceId={7} />)
    expect(screen.getByRole('button', { expanded: true })).toBeTruthy()
    expect(screen.getByText('Rinse aid')).toBeTruthy()
    expect(screen.queryByText('Salt · Low')).toBeNull()
  })

  it('collapsed by the operator, it names the worst item ("Salt · Low")', () => {
    mockResult.slice = status(LOW_SALT)
    render(<ConsumablesPanel deviceId={7} />)
    fireEvent.click(screen.getByRole('button', { expanded: true }))
    expect(screen.getByText('Salt · Low')).toBeTruthy()
    expect(screen.queryByText('Rinse aid')).toBeNull()
  })

  it('several items need attention → the count', () => {
    mockResult.slice = status([
      { key: 'a', label: 'A', level: null, status: 'low', lastResetAt: null, resettable: false },
      {
        key: 'b',
        label: 'B',
        level: null,
        status: 'replace',
        lastResetAt: null,
        resettable: false,
      },
    ])
    localStorage.setItem(consumablesOpenStorageKey(7), 'closed')
    render(<ConsumablesPanel deviceId={7} />)
    expect(screen.getByText('2 need attention')).toBeTruthy()
  })

  it('the operator’s toggle is remembered per device, over the default', () => {
    mockResult.slice = status(OK_ITEMS)
    const first = render(<ConsumablesPanel deviceId={7} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByText('80%')).toBeTruthy()
    first.unmount()
    render(<ConsumablesPanel deviceId={7} />)
    expect(screen.getByText('80%')).toBeTruthy()
    cleanup()
    // Another device keeps its own default.
    render(<ConsumablesPanel deviceId={8} />)
    expect(screen.queryByText('80%')).toBeNull()
  })

  it('unknown items are not "All OK"', () => {
    mockResult.slice = status([
      {
        key: 'salt',
        label: 'Salt',
        level: null,
        status: 'ok',
        lastResetAt: null,
        resettable: false,
      },
      { key: 'x', label: 'X', level: null, status: null, lastResetAt: null, resettable: false },
    ])
    render(<ConsumablesPanel deviceId={7} />)
    expect(screen.queryByText('All OK')).toBeNull()
    expect(screen.getByText('1 OK · 1 unknown')).toBeTruthy()
  })
})

describe('ConsumablesPanel — one look per form (D915)', () => {
  function formOf(label: string): string | null {
    return screen.getByText(label).closest('[data-form]')?.getAttribute('data-form') ?? null
  }

  it('derives the form from the kind when the provider names none', () => {
    mockResult.slice = status([
      {
        key: 'brush',
        label: 'Brush',
        level: 70,
        status: null,
        lastResetAt: null,
        resettable: true,
      },
      {
        key: 'bin',
        label: 'Bin',
        level: 20,
        status: null,
        kind: 'waste',
        lastResetAt: null,
        resettable: false,
      },
      {
        key: 'salt',
        label: 'Salt',
        level: null,
        status: 'ok',
        kind: 'supply',
        lastResetAt: null,
        resettable: false,
      },
    ])
    render(<ConsumablesPanel deviceId={1} />)
    expect(formOf('Brush')).toBe('part')
    expect(formOf('Bin')).toBe('bin')
    expect(formOf('Salt')).toBe('product')
  })

  it('a part has the wear bar and the reset; a tank and a bin have a vertical gauge and no reset', () => {
    mockResult.slice = status([
      {
        key: 'brush',
        label: 'Brush',
        level: 70,
        status: null,
        lastResetAt: null,
        resettable: true,
      },
      {
        key: 'water',
        label: 'Clean water',
        level: 60,
        status: null,
        kind: 'supply',
        form: 'tank',
        lastResetAt: null,
        resettable: false,
      },
      {
        key: 'bin',
        label: 'Dust bin',
        level: 30,
        status: null,
        kind: 'waste',
        form: 'bin',
        lastResetAt: null,
        resettable: false,
      },
    ])
    render(<ConsumablesPanel deviceId={1} />)
    expect(screen.getAllByRole('button', { name: 'Replaced' })).toHaveLength(1)
    expect(screen.getAllByTestId('consumable-gauge')).toHaveLength(2)
  })

  it('a supply tank warns when low; a waste tank warns when full, not when low', () => {
    mockResult.slice = status([
      {
        key: 'clean',
        label: 'Clean water',
        level: 10,
        status: null,
        kind: 'supply',
        form: 'tank',
        lastResetAt: null,
        resettable: false,
      },
      {
        key: 'dirty',
        label: 'Dirty water',
        level: 10,
        status: null,
        kind: 'waste',
        form: 'tank',
        lastResetAt: null,
        resettable: false,
      },
      {
        key: 'dirty2',
        label: 'Dirty water 2',
        level: 95,
        status: null,
        kind: 'waste',
        form: 'tank',
        lastResetAt: null,
        resettable: false,
      },
    ])
    render(<ConsumablesPanel deviceId={1} />)
    expect(screen.getByText('Clean water').className).toContain('text-warning')
    expect(screen.getByText('Dirty water').className).not.toContain('text-warning')
    expect(screen.getByText('Dirty water 2').className).toContain('text-warning')
  })

  it('a product shows three steps and "refill" wording by level', () => {
    mockResult.slice = status([
      {
        key: 'det',
        label: 'Detergent',
        level: null,
        status: 'empty',
        kind: 'supply',
        form: 'product',
        lastResetAt: null,
        resettable: false,
      },
      {
        key: 'salt',
        label: 'Salt',
        level: null,
        status: 'ok',
        kind: 'supply',
        form: 'product',
        lastResetAt: null,
        resettable: false,
      },
    ])
    render(<ConsumablesPanel deviceId={1} />)
    expect(screen.getByText('Refill now')).toBeTruthy()
    const steps = screen
      .getAllByTestId('consumable-steps')
      .map((s) => s.getAttribute('data-filled'))
    expect(steps).toEqual(['0', '3'])
  })

  it('a bin warns when full', () => {
    mockResult.slice = status([
      {
        key: 'bin',
        label: 'Dust bin',
        level: null,
        status: 'full',
        kind: 'waste',
        form: 'bin',
        lastResetAt: null,
        resettable: false,
      },
    ])
    render(<ConsumablesPanel deviceId={1} />)
    expect(screen.getByText('Dust bin').className).toContain('text-warning')
    expect(screen.getByText('Full')).toBeTruthy()
  })
})
