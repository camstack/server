import { describe, expect, it } from 'vitest'
import { findSelfDrawnPower } from '../check-no-hero-self-drawn-power'

const DIR = 'packages/ui-library/src/composites/device-controls'

describe('check-no-hero-self-drawn-power', () => {
  it('flags a hero card that reads the power-meter slice', () => {
    const found = findSelfDrawnPower([
      { rel: `${DIR}/heater-control.tsx`, content: 'cap: (d) => d.powerMeter,\n' },
    ])
    expect(found).toHaveLength(1)
    expect(found[0]?.line).toBe(1)
  })

  it('lets a sensor device read its own reading, and skips comments', () => {
    expect(
      findSelfDrawnPower([
        { rel: `${DIR}/sensor-value-atom.tsx`, content: 'getSliceHandle: (s) => s.powerMeter,' },
        { rel: `${DIR}/appliance-control.tsx`, content: ' * the `power-meter` cap draws it\n' },
      ]),
    ).toEqual([])
  })

  it('also watches the admin-ui hero cards', () => {
    const found = findSelfDrawnPower([
      {
        rel: 'packages/addon-admin-ui/src/components/device/hero/HeaterHero.tsx',
        content: 'const watts = device.powerMeter?.power\n',
      },
    ])
    expect(found).toHaveLength(1)
  })
})
