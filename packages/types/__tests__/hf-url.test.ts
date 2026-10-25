import { describe, it, expect } from 'vitest'
import { hfModelUrl } from '../src/utils/hf-url.js'

describe('hfModelUrl', () => {
  it('builds a correct huggingface URL', () => {
    const url = hfModelUrl('camstack/camstack-models', 'objectDetection/yolov8/onnx/model.onnx')
    expect(url).toBe(
      'https://huggingface.co/camstack/camstack-models/resolve/main/objectDetection/yolov8/onnx/model.onnx',
    )
  })

  it('contains huggingface.co domain', () => {
    const url = hfModelUrl('org/repo', 'path/to/file.onnx')
    expect(url).toContain('huggingface.co')
  })

  it('includes the repo in the URL', () => {
    const url = hfModelUrl('my-org/my-repo', 'some/path.onnx')
    expect(url).toContain('my-org/my-repo')
  })

  it('includes the path in the URL', () => {
    const url = hfModelUrl('org/repo', 'models/v1/model.onnx')
    expect(url).toContain('models/v1/model.onnx')
  })

  it('uses /resolve/main/ path segment', () => {
    const url = hfModelUrl('org/repo', 'file.onnx')
    expect(url).toContain('/resolve/main/')
  })
})
