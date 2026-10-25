import { describe, expect, it } from 'vitest'
import { CompositionRunStatusSchema } from '../../composition/composition-report.js'
import {
  ROOM_EXAMPLE_MOTION_SOURCES,
  ROOM_EXAMPLE_TEMPERATURE_SOURCES,
  ROOM_OCCUPANCY_WINDOW_MS,
  roomCompositionExample,
} from '../../composition/examples.js'
import {
  CoreBlockSchema,
  CoreBlockStatusSchema,
  coreBlockComposition,
  coreBlockSourceKind,
} from '../core-blocks.cap.js'

const BASE = {
  id: 'b1',
  name: 'Room',
  code: '',
  enabled: true,
  placement: 'hub',
  createdAt: 1,
  updatedAt: 1,
  createdBy: 'u1',
  status: 'stopped',
  lastChangedAt: 1,
}

describe('CoreBlock.source', () => {
  it('a legacy row with no source is a code block', () => {
    expect(
      coreBlockSourceKind(CoreBlockSchema.parse({ ...BASE, code: 'export default () => {}' })),
    ).toBe('code')
  })
  it('a composition block carries its composition', () => {
    const composition = roomCompositionExample({
      temperatureSources: ROOM_EXAMPLE_TEMPERATURE_SOURCES,
      motionSources: ROOM_EXAMPLE_MOTION_SOURCES,
      occupancyWindowMs: ROOM_OCCUPANCY_WINDOW_MS,
    })
    const block = CoreBlockSchema.parse({ ...BASE, source: { kind: 'composition', composition } })
    expect(coreBlockSourceKind(block)).toBe('composition')
    expect(coreBlockComposition(block)).toEqual(composition)
  })
  it('the composer run status mirrors the block status', () => {
    expect(CompositionRunStatusSchema.options).toEqual(CoreBlockStatusSchema.options)
  })
  it('a block with a field released to the native provider is `degraded` (S1b, D663)', () => {
    expect(CoreBlockStatusSchema.options).toContain('degraded')
    expect(CompositionRunStatusSchema.options).toContain('degraded')
  })
})
