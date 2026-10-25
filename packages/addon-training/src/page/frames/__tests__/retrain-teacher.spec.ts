import type { PipelineSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { teacherCandidates } from '../lib/retrain-teacher.js'

function schema(format: PipelineSchema['selectedEngine']['format']): PipelineSchema {
  return {
    availableEngines: [],
    selectedEngine: { runtime: 'python', backend: 'openvino', format },
    slots: [
      {
        id: 'detector',
        label: 'Detector',
        priority: 0,
        parentSlot: null,
        addons: [
          {
            id: 'object-detection',
            name: 'Object Detection',
            slot: 'detector',
            inputClasses: [],
            outputClasses: ['person'],
            childSlots: [],
            defaultModelId: 'yolo26n',
            defaultConfidence: 0.5,
            models: [
              {
                id: 'yolo26n',
                name: 'YOLO26 Nano',
                formats: { openvino: { downloaded: true, sizeMB: 5 } },
              },
              {
                id: 'yolov9m-320',
                name: 'YOLOv9m',
                formats: { openvino: { downloaded: true, sizeMB: 40 } },
              },
              {
                id: 'yolo26l',
                name: 'YOLO26 Large',
                formats: { openvino: { downloaded: false, sizeMB: 95 } },
              },
              {
                id: 'yolo26x',
                name: 'YOLO26 XLarge',
                legacy: true,
                formats: { openvino: { downloaded: false, sizeMB: 213 } },
              },
              {
                id: 'coreml-only',
                name: 'CoreML only',
                formats: { coreml: { downloaded: false, sizeMB: 300 } },
              },
            ],
          },
        ],
      },
    ],
  }
}

describe('teacherCandidates', () => {
  it('offers the detectors larger than the camera’s, on the node’s format, largest first', () => {
    expect(teacherCandidates(schema('openvino'), 'yolov9m-320').map((c) => c.modelId)).toEqual([
      'yolo26l',
    ])
    expect(teacherCandidates(schema('openvino'), 'yolo26n').map((c) => c.modelId)).toEqual([
      'yolo26l',
      'yolov9m-320',
    ])
  })

  it('never offers a hidden model — the node would resolve it to another one', () => {
    expect(
      teacherCandidates(schema('openvino'), 'yolo26n').some((c) => c.modelId === 'yolo26x'),
    ).toBe(false)
  })

  it('answers nothing it cannot know', () => {
    expect(teacherCandidates(undefined, 'yolo26n')).toEqual([])
    expect(teacherCandidates(schema('onnx'), 'yolo26n')).toEqual([])
  })
})
