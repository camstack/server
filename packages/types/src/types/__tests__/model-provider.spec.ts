import { describe, expect, it } from 'vitest'
import { inferModelProvider } from '../models.js'

describe('inferModelProvider', () => {
  it('honours an explicit provider stamp', () => {
    expect(inferModelProvider({ id: 'yolo26n', provider: 'custom' })).toBe('custom')
  })

  it('maps plus-catalog ids and import descriptions', () => {
    expect(inferModelProvider({ id: 'frigate-mobiledet-edgetpu' })).toBe('frigate')
    expect(
      inferModelProvider({
        id: 'my-plus',
        description: 'frigate-plus personal model (yolonas) — imported via Model Studio',
      }),
    ).toBe('frigate')
  })

  it('maps plugin-catalog ids and import descriptions, not CamStack yolov9', () => {
    expect(inferModelProvider({ id: 'scrypted-yolov9s-relu-onnx' })).toBe('scrypted')
    expect(
      inferModelProvider({
        id: 'yolov9s',
        description: 'CamStack YOLOv9 Small',
      }),
    ).toBe('custom')
    expect(
      inferModelProvider({
        id: 'anything',
        description: 'YOLOv9T ReLU — imported from the local scrypted-yolov9t catalog.',
      }),
    ).toBe('scrypted')
  })

  it('falls back to custom for unstamped BYO entries', () => {
    expect(inferModelProvider({ id: 'my-wildlife', description: 'Uploaded ONNX' })).toBe('custom')
  })
})
