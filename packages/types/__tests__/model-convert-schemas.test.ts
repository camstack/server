import { describe, it, expect } from 'vitest'
import {
  ConvertTargetSchema,
  ModelConvertMetadataSchema,
  ConvertResultSchema,
} from '../src/types/models.js'

describe('model-convert schemas', () => {
  it('accepts an openvino target with precisions', () => {
    const parsed = ConvertTargetSchema.parse({ format: 'openvino', precisions: ['fp16', 'int8'] })
    expect(parsed).toEqual({ format: 'openvino', precisions: ['fp16', 'int8'] })
  })

  it('accepts a coreml target with no precisions', () => {
    expect(ConvertTargetSchema.parse({ format: 'coreml' })).toEqual({ format: 'coreml' })
  })

  it('rejects an openvino target with an unknown precision', () => {
    expect(() => ConvertTargetSchema.parse({ format: 'openvino', precisions: ['fp8'] })).toThrow()
  })

  it('round-trips full convert metadata', () => {
    const meta = {
      id: 'custom-yolo',
      name: 'Custom YOLO',
      labels: [{ id: '0', name: 'person' }],
      inputSize: { width: 640, height: 640 },
      inputLayout: 'nchw',
      inputNormalization: 'zero-one',
      preprocessMode: 'letterbox',
      outputFormat: 'yolo',
    }
    expect(ModelConvertMetadataSchema.parse(meta)).toMatchObject(meta)
  })

  it('rejects a path-traversal id', () => {
    expect(() =>
      ModelConvertMetadataSchema.parse({
        id: '../../etc/x',
        name: 'bad',
        labels: [{ id: '0', name: 'person' }],
        inputSize: { width: 640, height: 640 },
        outputFormat: 'yolo',
      }),
    ).toThrow()
  })

  it('accepts a valid id with alphanumeric, dot, underscore, and hyphen characters', () => {
    expect(() =>
      ModelConvertMetadataSchema.parse({
        id: 'custom-yolo26n',
        name: 'Custom YOLO26n',
        labels: [{ id: '0', name: 'person' }],
        inputSize: { width: 640, height: 640 },
        outputFormat: 'yolo',
      }),
    ).not.toThrow()
  })

  it('validates a ConvertResult carrying an entry + artifacts', () => {
    const result = {
      entry: {
        id: 'custom-yolo',
        name: 'Custom YOLO',
        description: 'converted',
        formats: {
          openvino: {
            url: 'camstack-local://x/camstack-custom-yolo.xml',
            sizeMB: 9,
            files: ['camstack-custom-yolo.bin'],
          },
        },
        inputSize: { width: 640, height: 640 },
        labels: [{ id: '0', name: 'person' }],
      },
      artifacts: [
        {
          format: 'openvino',
          precision: 'fp16',
          sizeMB: 9,
          validated: true,
          files: ['camstack-custom-yolo.xml', 'camstack-custom-yolo.bin'],
        },
      ],
    }
    expect(ConvertResultSchema.parse(result)).toMatchObject({ artifacts: [{ validated: true }] })
  })
})
