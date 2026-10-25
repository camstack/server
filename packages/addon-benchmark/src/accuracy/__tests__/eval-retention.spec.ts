import { describe, expect, it } from 'vitest'
import { type EvalRunRow, evalRunsToTrim } from '../eval-retention.js'

const run = (
  id: string,
  createdAt: number,
  extra: Partial<EvalRunRow['body']> = {},
): EvalRunRow => ({
  id,
  body: {
    datasetId: 'retrain-1',
    deviceKey: 'openvino:npu',
    createdAt,
    isReference: false,
    ...extra,
  },
})

describe('evalRunsToTrim', () => {
  it('keeps the newest N per dataset×device and trims the rest, oldest first', () => {
    const runs = [run('r1', 1), run('r2', 2), run('r3', 3), run('r4', 4)]
    expect(evalRunsToTrim(runs, 2)).toEqual(['r1', 'r2'])
  })

  it('never trims a reference run, and a reference takes no slot', () => {
    const runs = [run('ref', 0, { isReference: true }), run('r1', 1), run('r2', 2), run('r3', 3)]
    expect(evalRunsToTrim(runs, 2)).toEqual(['r1'])
    expect(evalRunsToTrim([run('ref', 0, { isReference: true })], 0)).toEqual([])
  })

  it('counts each dataset×device on its own', () => {
    const runs = [
      run('npu-1', 1),
      run('npu-2', 2),
      run('gpu-1', 1, { deviceKey: 'openvino:gpu' }),
      run('coco-1', 1, { datasetId: 'coco-val2017' }),
    ]
    expect(evalRunsToTrim(runs, 1)).toEqual(['npu-1'])
  })

  it('trims nothing under the bound', () => {
    expect(evalRunsToTrim([run('r1', 1), run('r2', 2)])).toEqual([])
  })
})
