import { describe, expect, it } from 'vitest'
import { resolveRootFrameViewSpec } from '../root-frame-view.js'

describe('root frame views', () => {
  it('requests independent content-sized YOLO views without square pre-letterbox pixels', () => {
    const source = { width: 1920, height: 1080 }
    const root320 = resolveRootFrameViewSpec(
      { inputSize: { width: 320, height: 320 }, preprocessMode: 'letterbox' },
      source,
    )
    const root640 = resolveRootFrameViewSpec(
      { inputSize: { width: 640, height: 640 }, preprocessMode: 'letterbox' },
      source,
    )

    expect(root320).toMatchObject({
      content: { width: 320, height: 180 },
      fit: 'contain',
      format: 'jpeg',
    })
    expect(root640).toMatchObject({
      content: { width: 640, height: 360 },
      fit: 'contain',
      format: 'jpeg',
    })
    expect(root320.content).not.toEqual(root640.content)
  })

  it('keeps heterogeneous resize roots and source crops independent', () => {
    const source = { width: 1920, height: 1080 }
    const stretched = resolveRootFrameViewSpec(
      { inputSize: { width: 576, height: 576 }, preprocessMode: 'resize' },
      source,
    )
    const cropped = resolveRootFrameViewSpec(
      { inputSize: { width: 320, height: 320 }, preprocessMode: 'letterbox' },
      source,
      { left: 480, top: 270, width: 960, height: 540 },
    )

    expect(stretched).toMatchObject({
      content: { width: 576, height: 576 },
      fit: 'stretch',
    })
    expect(cropped).toMatchObject({
      crop: { left: 480, top: 270, width: 960, height: 540 },
      content: { width: 320, height: 180 },
    })
  })
})
