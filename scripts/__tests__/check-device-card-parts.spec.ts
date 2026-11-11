import { describe, expect, it } from 'vitest'
import { findCardPartProblems } from '../check-device-card-parts.js'

const rules = (file: string, source: string): string[] =>
  findCardPartProblems(file, source).map((f) => f.rule)

describe('findCardPartProblems — a card is assembled from the shared parts', () => {
  it('refuses an emoji anywhere in the card tree', () => {
    expect(rules('scenes/plug/PlugCard.tsx', 'const label = "\u{1F50C} Plug"')).toEqual(['emoji'])
    expect(rules('__fixtures__/plug.ts', "name: 'Lamp \u{26A1}'")).toEqual(['emoji'])
  })

  it('lets only icons.ts import lucide-react', () => {
    const source = "import { Power } from 'lucide-react'"
    expect(rules('icons.ts', source)).toEqual([])
    expect(rules('parts/CardButton.tsx', source)).toEqual(['lucide-import'])
    expect(rules('scenes/climate/ClimateCard.tsx', source)).toEqual(['lucide-import'])
  })

  it('keeps an inline svg in illustrations/ and parts/', () => {
    const source = '<svg viewBox="0 0 10 10">'
    expect(rules('illustrations/PlugIllustration.tsx', source)).toEqual([])
    expect(rules('parts/Dial.tsx', source)).toEqual([])
    expect(rules('scenes/plug/PlugCard.tsx', source)).toEqual(['inline-svg'])
    expect(rules('shell/DeviceCard.tsx', '  <svg>')).toEqual(['inline-svg'])
  })

  it('refuses a timer of its own inside a scene, and only there', () => {
    const source = 'const id = setTimeout(() => setArmed(false), 5000)'
    expect(rules('scenes/plug/PlugCard.tsx', source)).toEqual(['scene-timer'])
    expect(rules('scenes/climate/model.ts', 'setInterval(tick, 1000)')).toEqual(['scene-timer'])
    expect(rules('parts/ArmedButton.tsx', source)).toEqual([])
  })

  it('reports the line and skips specs', () => {
    const hit = findCardPartProblems('scenes/plug/PlugCard.tsx', 'a\nb\n<svg>')
    expect(hit[0]?.line).toBe(3)
    expect(rules('__tests__/plug.spec.tsx', '<svg>')).toEqual([])
  })

  it('does not trip on a word that only contains "svg" or names a timer', () => {
    expect(rules('scenes/plug/PlugCard.tsx', 'const svgTitle = useCountdown(endsAt)')).toEqual([])
  })
})
