import { describe, expect, it } from 'vitest'
import {
  buildZeroShotPrototypes,
  classifyZeroShot,
  VEHICLE_TYPE_LABELS,
  zeroShotPrompt,
} from '../clip-zero-shot.js'

/** A fake text tower: each label's prompt maps to its own axis. */
const axisFor = (text: string): number =>
  VEHICLE_TYPE_LABELS.findIndex((l) => text === zeroShotPrompt(l))

const encode = async (text: string, _modelId: string): Promise<readonly number[]> =>
  Array.from({ length: 8 }, (_, i) => (i === axisFor(text) ? 1 : 0))

describe('zero-shot vehicle type over the CLIP vector (D649 seam)', () => {
  it('prompts exactly as the spike measured, lower-cased', () => {
    expect(zeroShotPrompt('Van')).toBe('a photo of a van.')
  })

  it("labels with vehicle-type-v1's own strings", async () => {
    const protos = await buildZeroShotPrototypes(VEHICLE_TYPE_LABELS, 'siglip2-b16-224', encode)
    const vec = [0, 0, 0, 0.2, 0, 0, 0.9, 0.1] // closest to Truck
    expect(classifyZeroShot(protos, { vector: vec, modelId: 'siglip2-b16-224' })).toMatchObject({
      kind: 'label',
      label: 'Truck',
    })
  })

  it('refuses a vector from ANOTHER model — cross-space cosine is noise', async () => {
    const protos = await buildZeroShotPrototypes(VEHICLE_TYPE_LABELS, 'siglip2-b16-224', encode)
    expect(
      classifyZeroShot(protos, { vector: new Array(8).fill(0.1), modelId: 'mobileclip-s1' }),
    ).toEqual({ kind: 'refused', reason: 'other-model' })
  })

  it('refuses a wrong dimension and a margin too thin to call', async () => {
    const protos = await buildZeroShotPrototypes(VEHICLE_TYPE_LABELS, 'siglip2-b16-224', encode)
    expect(classifyZeroShot(protos, { vector: [1, 0], modelId: 'siglip2-b16-224' })).toEqual({
      kind: 'refused',
      reason: 'dimension',
    })
    const tie = [0, 0, 0, 0.5, 0, 0, 0, 0.5] // Car == Van
    expect(classifyZeroShot(protos, { vector: tie, modelId: 'siglip2-b16-224' })).toEqual({
      kind: 'refused',
      reason: 'margin',
    })
  })
})
