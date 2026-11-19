import { describe, expect, it } from 'vitest'
import { pickImageTag, type DetectedAccelerator } from '../host-check/advise.js'
import type { ImageVariant } from '../mcp/image-variants.js'

function used(kind: DetectedAccelerator['kind'], variant?: ImageVariant): DetectedAccelerator {
  return {
    kind,
    label: kind,
    status: 'used',
    hostPaths: [],
    visibleHere: null,
    note: '',
    ...(variant === undefined ? {} : { variant }),
  }
}

/** Every enumeration order of the accelerators must pick the same tag. */
function allOrders(items: readonly DetectedAccelerator[]): DetectedAccelerator[][] {
  if (items.length <= 1) return [[...items]]
  return items.flatMap((item, i) =>
    allOrders([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  )
}

function tagsOf(items: readonly DetectedAccelerator[]): string[] {
  return [...new Set(allOrders(items).map((order) => pickImageTag(order)))]
}

describe('pickImageTag — a fixed precedence, whatever the enumeration order', () => {
  it('an Intel iGPU alone takes its own variant', () => {
    expect(tagsOf([used('intel-gpu', 'intel')])).toEqual(['intel-latest'])
    expect(tagsOf([used('intel-gpu', 'intel-legacy')])).toEqual(['intel-legacy-latest'])
  })

  it('an AMD dGPU plus an Intel NPU keeps the amd image (the pre-variant outcome)', () => {
    expect(tagsOf([used('amd-gpu', 'amd'), used('intel-npu', 'intel')])).toEqual(['amd-latest'])
  })

  it('an Intel iGPU plus an AMD dGPU takes the intel image in either order', () => {
    expect(tagsOf([used('intel-gpu', 'intel'), used('amd-gpu', 'amd')])).toEqual(['intel-latest'])
    expect(tagsOf([used('intel-gpu', 'intel-legacy'), used('amd-gpu', 'amd')])).toEqual([
      'intel-legacy-latest',
    ])
  })

  it('an Intel NPU wins over a legacy-classified Intel iGPU', () => {
    expect(tagsOf([used('intel-gpu', 'intel-legacy'), used('intel-npu', 'intel')])).toEqual([
      'intel-latest',
    ])
  })

  it('NVIDIA is chosen only when no Intel or AMD accelerator is used', () => {
    expect(tagsOf([used('nvidia', 'nvidia')])).toEqual(['nvidia-latest'])
    expect(tagsOf([used('nvidia', 'nvidia-legacy')])).toEqual(['nvidia-legacy-latest'])
    expect(tagsOf([used('nvidia', 'nvidia'), used('amd-gpu', 'amd')])).toEqual(['amd-latest'])
  })

  it('a host with no GPU accelerator takes the intel image', () => {
    expect(tagsOf([used('coral-usb')])).toEqual(['intel-latest'])
    expect(tagsOf([])).toEqual(['intel-latest'])
  })
})
