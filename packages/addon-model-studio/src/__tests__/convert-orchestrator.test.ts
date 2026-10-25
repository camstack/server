import { it, expect, vi } from 'vitest'
import { recommendConvertNode, convertModel } from '../convert-orchestrator.js'

const probe: Record<
  string,
  { platform: string; gpu?: { type: string }; npu?: { type: string }; openvino: boolean }
> = {
  hub: { platform: 'linux', gpu: { type: 'intel' }, openvino: true },
  'agent-a': { platform: 'linux', gpu: { type: 'intel' }, openvino: true },
  'mac-mini': { platform: 'darwin', npu: { type: 'apple-ane' }, openvino: false },
}

it('recommends a darwin node first for coreml', async () => {
  const ranked = await recommendConvertNode(
    { targets: [{ format: 'coreml' }] },
    { listNodes: async () => Object.keys(probe), hardwareOf: async (n) => probe[n]! },
  )
  expect(ranked[0]?.nodeId).toBe('mac-mini')
  expect(ranked[0]?.supported).toBe(true)
})

it('recommends an openvino node for openvino targets and excludes darwin', async () => {
  const ranked = await recommendConvertNode(
    { targets: [{ format: 'openvino', precisions: ['fp16'] }] },
    { listNodes: async () => Object.keys(probe), hardwareOf: async (n) => probe[n]! },
  )
  expect(ranked.find((r) => r.nodeId === 'mac-mini')?.supported).toBe(false)
  expect(ranked[0]?.supported).toBe(true)
})

it('convertModel pins convert to the chosen node, then registers + marks availability', async () => {
  const convert = vi.fn(async (_input: unknown, _pin: unknown) => ({
    entry: {
      id: 'm',
      name: 'M',
      description: '',
      formats: {
        openvino: {
          url: 'camstack-local://m/camstack-m.xml',
          sizeMB: 9,
          files: ['camstack-m.bin'],
        },
      },
      inputSize: { width: 640, height: 640 },
      labels: [{ id: '0', name: 'a' }],
    },
    artifacts: [
      {
        format: 'openvino' as const,
        precision: 'fp16' as const,
        sizeMB: 9,
        validated: true,
        files: ['camstack-m.xml', 'camstack-m.bin'],
      },
    ],
  }))
  const register = vi.fn(async () => {})
  const markAvailable = vi.fn(async () => {})
  const out = await convertModel(
    {
      sourceUrl: 'https://x/m.onnx',
      metadata: {
        id: 'm',
        name: 'M',
        labels: [{ id: '0', name: 'a' }],
        inputSize: { width: 640, height: 640 },
        outputFormat: 'yolo',
      },
      targets: [{ format: 'openvino', precisions: ['fp16'] }],
      targetNodeId: 'agent-a',
    },
    {
      convert,
      register,
      markAvailable,
      recommend: async () => [{ nodeId: 'agent-a', reason: 'ov', supported: true }],
    },
  )
  expect(convert).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      context: expect.objectContaining({ __camstackNodePin: 'agent-a' }),
    }),
  )
  expect(register).toHaveBeenCalled()
  expect(markAvailable).toHaveBeenCalledWith('agent-a', 'm', expect.anything())
  expect(out.nodeId).toBe('agent-a')
})
