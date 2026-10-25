// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { ModelVariantSource } from '@camstack/types'
import { GroupedModelSelector } from '../grouped-model-selector'

// Minimal reduced-shape catalog (as a stepper would pass it): one active family
// with n/s tiers, an int8 variant on Nano, plus a legacy entry that must never
// surface.
const CATALOG: readonly ModelVariantSource[] = [
  {
    id: 'yolo26n',
    name: 'YOLO26 Nano',
    group: { family: 'yolo26', tier: 'n' },
    formats: { onnx: { sizeMB: 5 }, coreml: { sizeMB: 6 } },
  },
  {
    id: 'yolo26n-int8',
    name: 'YOLO26 Nano Int8',
    group: { family: 'yolo26', tier: 'n', precision: 'int8' },
    formats: { openvino: { sizeMB: 3 } },
  },
  {
    id: 'yolo26s',
    name: 'YOLO26 Small',
    group: { family: 'yolo26', tier: 's' },
    formats: { onnx: { sizeMB: 12 } },
  },
  {
    id: 'yolov9s',
    name: 'YOLOv9 Small (legacy)',
    legacy: true,
    group: { family: 'yolov9', tier: 's' },
    formats: { onnx: { sizeMB: 9 } },
  },
]

describe('GroupedModelSelector', () => {
  it('renders the tier ladder and the selected tier variants', () => {
    render(<GroupedModelSelector catalog={CATALOG} value="yolo26n" onChange={() => {}} />)
    expect(screen.getByText('Nano')).not.toBeNull()
    expect(screen.getByText('Small')).not.toBeNull()
    // Nano is selected → its Standard + Int8 variants are the variant chips.
    expect(screen.getByText('Standard')).not.toBeNull()
    expect(screen.getByText('Int8')).not.toBeNull()
  })

  it('hides the family row for a single family and excludes legacy families', () => {
    render(<GroupedModelSelector catalog={CATALOG} value="yolo26n" onChange={() => {}} />)
    expect(screen.queryByText('Family')).toBeNull()
    // The legacy yolov9 entry never appears.
    expect(screen.queryByText(/YOLOv9/)).toBeNull()
  })

  it('resolves a variant click to its flat model id', () => {
    const onChange = vi.fn()
    render(<GroupedModelSelector catalog={CATALOG} value="yolo26n" onChange={onChange} />)
    fireEvent.click(screen.getByText('Int8'))
    expect(onChange).toHaveBeenCalledWith('yolo26n-int8')
  })

  it('switching tier preserves the precision axis, falling back to the base', () => {
    const onChange = vi.fn()
    // Small has no int8 build → picking Small from a yolo26n-int8 selection
    // falls back to the tier base yolo26s.
    render(<GroupedModelSelector catalog={CATALOG} value="yolo26n-int8" onChange={onChange} />)
    fireEvent.click(screen.getByText('Small'))
    expect(onChange).toHaveBeenCalledWith('yolo26s')
  })

  it('omits "~0 MB" when size is unknown (plus catalog list has no bytes)', () => {
    const unknown: readonly ModelVariantSource[] = [
      {
        id: 'plus-y9t',
        name: 'YOLOv9 Tiny',
        group: { family: 'yolov9', tier: 't', resolution: 320 },
        formats: { onnx: { sizeMB: 0 } },
      },
      {
        id: 'plus-y9s',
        name: 'YOLOv9 Small',
        group: { family: 'yolov9', tier: 's', resolution: 320 },
        formats: { onnx: { sizeMB: 0 } },
      },
    ]
    render(<GroupedModelSelector catalog={unknown} value="plus-y9t" onChange={() => {}} />)
    expect(screen.getByText('Tiny')).not.toBeNull()
    expect(screen.getByText('Small')).not.toBeNull()
    expect(screen.queryByText(/~0\s*MB/)).toBeNull()
    expect(screen.queryByText(/0 MB/)).toBeNull()
  })

  it('hides size and Variant when each axis has only one option', () => {
    const single: readonly ModelVariantSource[] = [
      {
        id: 'plus-y9t',
        name: 'YOLOv9 Tiny',
        group: { family: 'yolov9', tier: 't', resolution: 320 },
        formats: { onnx: { sizeMB: 4 } },
      },
    ]
    render(<GroupedModelSelector catalog={single} value="plus-y9t" onChange={() => {}} />)
    expect(screen.queryByText(/— size/)).toBeNull()
    expect(screen.queryByText('Variant')).toBeNull()
    expect(screen.queryByText('Tiny')).toBeNull()
  })
})

// Catalog with the reduced-input resolution axis (native 640 + 320 + 256).
const RES_CATALOG: readonly ModelVariantSource[] = [
  {
    id: 'yolo26n',
    name: 'YOLO26 Nano',
    group: { family: 'yolo26', tier: 'n' },
    formats: { onnx: { sizeMB: 10 } },
  },
  {
    id: 'yolo26n-320',
    name: 'YOLO26 Nano @320',
    group: { family: 'yolo26', tier: 'n', resolution: 320 },
    formats: { onnx: { sizeMB: 10 } },
  },
  {
    id: 'yolo26n-256',
    name: 'YOLO26 Nano @256',
    group: { family: 'yolo26', tier: 'n', resolution: 256 },
    formats: { onnx: { sizeMB: 10 } },
  },
]

describe('GroupedModelSelector — resolution axis', () => {
  it('renders a Resolution row when a tier ships reduced-input builds', () => {
    render(<GroupedModelSelector catalog={RES_CATALOG} value="yolo26n" onChange={() => {}} />)
    expect(screen.getByText('Resolution')).not.toBeNull()
    // "native" — the number is not hardcoded. This chip used to read
    // "640 · native" for ANY family whose entry omitted its resolution.
    expect(screen.getByText('native')).not.toBeNull()
    expect(screen.getByText('320')).not.toBeNull()
    expect(screen.getByText('256')).not.toBeNull()
  })

  it('selecting a reduced resolution resolves to that model id', () => {
    const onChange = vi.fn()
    render(<GroupedModelSelector catalog={RES_CATALOG} value="yolo26n" onChange={onChange} />)
    fireEvent.click(screen.getByText('320'))
    expect(onChange).toHaveBeenCalledWith('yolo26n-320')
  })
})

// A family whose every build states its own input and ships no resolution-less
// entry — our yolov9. The tier is chosen BEFORE the resolution chip, so a card
// reading "Tiny @640 · ~10 MB" is wrong the moment 320 is selected below it.
const V9_CATALOG: readonly ModelVariantSource[] = [
  {
    id: 'yolov9t-640',
    name: 'YOLOv9 Tiny @640',
    group: { family: 'yolov9', tier: 't', resolution: 640 },
    formats: { onnx: { sizeMB: 10 } },
  },
  {
    id: 'yolov9t-320',
    name: 'YOLOv9 Tiny @320',
    group: { family: 'yolov9', tier: 't', resolution: 320 },
    formats: { onnx: { sizeMB: 4 } },
  },
  {
    id: 'yolov9s-640',
    name: 'YOLOv9 Small @640',
    group: { family: 'yolov9', tier: 's', resolution: 640 },
    formats: { onnx: { sizeMB: 27 } },
  },
  {
    id: 'yolov9s-320',
    name: 'YOLOv9 Small @320',
    group: { family: 'yolov9', tier: 's', resolution: 320 },
    formats: { onnx: { sizeMB: 9 } },
  },
]

describe('GroupedModelSelector — the tier card never states a resolution', () => {
  it('labels tiers by name alone and spells the family as the product does', () => {
    render(<GroupedModelSelector catalog={V9_CATALOG} value="yolov9t-640" onChange={() => {}} />)
    expect(screen.getByText('Tiny')).not.toBeNull()
    expect(screen.getByText('Small')).not.toBeNull()
    expect(screen.queryByText(/@\s*640/)).toBeNull()
    expect(screen.getByText('YOLOv9 — size')).not.toBeNull()
  })

  it('shows the size of the SELECTED resolution, not a fixed one', () => {
    const { rerender } = render(
      <GroupedModelSelector catalog={V9_CATALOG} value="yolov9t-640" onChange={() => {}} />,
    )
    // 640 selected → the Tiny card quotes the 640 build.
    expect(screen.getByText('~10 MB')).not.toBeNull()
    // The card used to quote the tier base forever, so a 320 selection kept
    // advertising the 640 weight while the footer already read ~4 MB.
    rerender(<GroupedModelSelector catalog={V9_CATALOG} value="yolov9t-320" onChange={() => {}} />)
    expect(screen.getByText('~4 MB')).not.toBeNull()
    expect(screen.queryByText('~10 MB')).toBeNull()
  })

  it('offers the seg family next to the detector, with its hint', () => {
    const WITH_SEG: readonly ModelVariantSource[] = [
      ...CATALOG,
      {
        id: 'yolo26n-seg',
        name: 'YOLO26-seg Nano',
        group: { family: 'yolo26-seg', tier: 'n', resolution: 640 },
        formats: { onnx: { sizeMB: 11 } },
      },
      {
        id: 'yolo26s-seg',
        name: 'YOLO26-seg Small',
        group: { family: 'yolo26-seg', tier: 's', resolution: 640 },
        formats: { onnx: { sizeMB: 40 } },
      },
    ]
    const onChange = vi.fn()
    const { rerender } = render(
      <GroupedModelSelector catalog={WITH_SEG} value="yolo26n" onChange={onChange} />,
    )
    const chip = screen.getByText('YOLO26-seg')
    expect(chip.getAttribute('title')).toBe('detection + masks, slightly heavier')
    // The plain family carries no hint line.
    expect(screen.queryByTestId('model-family-hint')).toBeNull()
    fireEvent.click(chip)
    expect(onChange).toHaveBeenCalledWith('yolo26n-seg')
    rerender(<GroupedModelSelector catalog={WITH_SEG} value="yolo26s-seg" onChange={onChange} />)
    expect(screen.getByTestId('model-family-hint').textContent).toBe(
      'YOLO26-seg: detection + masks, slightly heavier',
    )
    // Tier labels drop the family word.
    expect(screen.getByText('Nano')).not.toBeNull()
    expect(screen.getByText('Small')).not.toBeNull()
  })
})
