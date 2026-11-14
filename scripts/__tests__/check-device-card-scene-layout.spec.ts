import { describe, expect, it } from 'vitest'
import { findSceneLayoutProblems } from '../check-device-card-scene-layout.js'

const rules = (file: string, source: string): string[] =>
  findSceneLayoutProblems(file, source).map((f) => f.rule)

describe('findSceneLayoutProblems — every scene is on the fixed layout', () => {
  it('refuses the free layout coming back', () => {
    expect(rules('shell/SceneGrid.tsx', 'export interface FreeSceneZones {')).toEqual([
      'free-layout',
    ])
    expect(rules('shell/SceneGrid.tsx', "data-columns={'free'}")).toEqual(['free-layout'])
  })

  it('refuses a node given to a side of a scene, and accepts column items', () => {
    expect(rules('scenes/plug/PlugCard.tsx', '        left: <Stepper />,')).toEqual([
      'free-zone-node',
    ])
    expect(rules('scenes/plug/PlugCard.tsx', '        right: (')).toEqual(['free-zone-node'])
    expect(rules('scenes/plug/PlugCard.tsx', '        left: [columnButton(')).toEqual([])
    expect(rules('shell/other.tsx', '        left: <X />,')).toEqual([])
  })

  it('lets only column-items.tsx build a ColumnItem', () => {
    const source = "return new ColumnItem('k', node)"
    expect(rules('shell/column-items.tsx', source)).toEqual([])
    expect(rules('scenes/fan/FanCard.tsx', source)).toEqual(['column-item-by-hand'])
  })

  it('keeps the column width in one constant', () => {
    expect(rules('card-css.ts', 'grid-template-columns:15% minmax(0,1fr) 15%')).toEqual([
      'column-percentage',
    ])
    expect(
      rules('card-css.ts', 'grid-template-columns:${SCENE_COLUMN_PCT}% minmax(0,1fr)'),
    ).toEqual([])
  })

  it('does not judge a spec', () => {
    expect(rules('__tests__/x.spec.tsx', 'new ColumnItem(')).toEqual([])
  })
})
