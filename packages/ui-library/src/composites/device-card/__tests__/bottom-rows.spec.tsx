import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BottomRow, rowStats, rowText } from '../shell/bottom-rows'
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
})
