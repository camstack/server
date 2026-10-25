/**
 * Placement mapper: trainable ids × cluster root devices → picker rows.
 */
import { describe, expect, it } from 'vitest'
import { buildClusterRootModelRows } from '../cluster-root-model-rows.js'

describe('buildClusterRootModelRows', () => {
  it('lists every placement where a trainable model is the effective root', () => {
    const rows = buildClusterRootModelRows(
      [
        {
          modelId: 'yolo26n',
          label: 'YOLO26n',
          weights: 'w',
          imgsz: 320,
          baselineOnnxUrl: '',
          baselineFloors: {},
          recommended: true,
        },
        {
          modelId: 'other',
          label: 'Other',
          weights: 'w',
          imgsz: 320,
          baselineOnnxUrl: '',
          baselineFloors: {},
          recommended: false,
        },
      ],
      [
        {
          nodeId: 'hub',
          devices: [
            {
              key: 'openvino:gpu',
              backend: 'openvino',
              device: 'gpu',
              enabled: true,
              format: 'openvino',
              defaultModelId: 'yolo26n',
            },
          ],
          schema: {
            slots: [
              {
                addons: [
                  {
                    id: 'object-detection',
                    slot: 'detector',
                    defaultModelId: 'yolo26n',
                    models: [
                      {
                        id: 'yolo26n',
                        formats: { openvino: { sizeMB: 10 } },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      ],
    )
    expect(rows.clusterRootModelIds).toEqual(['yolo26n'])
    const yolo = rows.models.find((m) => m.modelId === 'yolo26n')
    expect(yolo?.placements).toEqual([
      expect.objectContaining({ nodeId: 'hub', deviceKey: 'openvino:gpu' }),
    ])
    expect(rows.models.find((m) => m.modelId === 'other')?.placements).toEqual([])
  })
})
