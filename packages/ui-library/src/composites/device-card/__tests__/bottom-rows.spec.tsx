import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import * as rows from '../shell/bottom-rows'
import { BottomRow, rowLevels, rowList, rowStats, rowStepper, rowText } from '../shell/bottom-rows'
import { SceneGrid } from '../shell/SceneGrid'

describe('the bottom rows', () => {
  it('draws one row per entry, in order, each tagged by kind with its optional label', () => {
    render(
      <SceneGrid
        image={<i />}
        columns={{}}
        bottom={[
          rowStats('a', {
            label: 'Energy',
            stats: [
              { id: 'x', name: 'Produced', value: '1 kWh' },
              { id: 'y', name: 'House', value: '2 kWh' },
            ],
          }),
          rowText('b', { text: 'All good' }),
        ]}
        corners={null}
        bottomCorners={false}
      />,
    )
    const rows = [...screen.getByTestId('dc-scene').querySelectorAll('[data-row]')]
    expect(rows.map((r) => r.getAttribute('data-row'))).toEqual(['stats', 'text'])
    expect(rows[0]?.textContent).toContain('Energy')
    expect(rows[0]?.textContent).toContain('Produced1 kWh')
    expect(rows[1]?.textContent).toBe('All good')
  })

  it('an empty list draws no bottom zone', () => {
    render(
      <SceneGrid image={<i />} columns={{}} bottom={[]} corners={null} bottomCorners={false} />,
    )
    const scene = screen.getByTestId('dc-scene')
    expect(scene.getAttribute('data-bottom')).toBe('false')
    expect(scene.querySelector('[data-zone="bottom"]')).toBeNull()
  })

  it('a row is built by the row factories only', () => {
    const refused = (): void => {
      // @ts-expect-error a BottomRow has a private constructor
      new BottomRow('x', 'text', undefined, <i />)
    }
    expect(refused).toBeTypeOf('function')
  })

  it('no row takes a loose node: the escape hatch is gone and a typed row refuses one', () => {
    // @ts-expect-error rowBlock was removed: a row is typed data, never a ReactNode
    expect(rows.rowBlock).toBeUndefined()
    const refused = (): void => {
      // @ts-expect-error a levels row takes levels, not content
      rowLevels('x', { content: <i /> })
      // @ts-expect-error a text row takes a string, not an element
      rowText('x', { text: <i /> })
    }
    expect(refused).toBeTypeOf('function')
    expect(Object.keys(rows).filter((name) => /block|node/i.test(name))).toEqual([])
  })

  it('draws a list, levels and a stepper from data alone', () => {
    render(
      <SceneGrid
        image={<i />}
        columns={{}}
        bottom={[
          rowList('l', {
            groups: [{ id: 'g', items: [{ id: 'a', label: 'Pressed', value: '' }] }],
          }),
          rowLevels('v', { levels: [{ id: 'w', label: 'Water', percent: 40 }] }),
          rowStepper('s', {
            name: 'Runs for',
            valueText: '5 min',
            decreaseLabel: 'less',
            increaseLabel: 'more',
            canDecrease: true,
            canIncrease: false,
            onDecrease: () => undefined,
            onIncrease: () => undefined,
          }),
        ]}
        corners={null}
        bottomCorners={false}
      />,
    )
    const kinds = [...screen.getByTestId('dc-scene').querySelectorAll('[data-row]')].map((r) =>
      r.getAttribute('data-row'),
    )
    expect(kinds).toEqual(['list', 'levels', 'stepper'])
    expect(screen.getByText('Water')).toBeTruthy()
    expect((screen.getByLabelText('more') as HTMLButtonElement).disabled).toBe(true)
  })
})
