import { describe, expect, it } from 'vitest'
import {
  IMAGE_VARIANTS,
  IMAGE_VARIANT_TABLE,
  intelVariantForDeviceId,
  intelVariantForName,
  nvidiaVariantForName,
} from '../mcp/image-variants.js'
import { IMAGE_TAG_BY_ACCELERATOR } from '../mcp/setup-install-rules.js'

describe('image variants — the one table', () => {
  it('every variant has a tag and the install rules read the same tag', () => {
    for (const v of IMAGE_VARIANTS) {
      expect(IMAGE_TAG_BY_ACCELERATOR[v]).toBe(IMAGE_VARIANT_TABLE[v].tag)
      expect(IMAGE_VARIANT_TABLE[v].tag).toBe(`${v}-latest`)
    }
  })

  it.each([
    ['0x3e92', 'intel-legacy'], // Coffee Lake
    ['0x5917', 'intel-legacy'], // Kaby Lake
    ['0x8a52', 'intel-legacy'], // Ice Lake
    ['0x4e71', 'intel-legacy'], // Jasper Lake
    ['0x4680', 'intel'], // Alder Lake
    ['0x46d1', 'intel'], // N100
    ['0x56a0', 'intel'], // Arc
    ['0x7d55', 'intel'], // Meteor Lake
    ['0xffff', null],
  ] as const)('Intel device id %s -> %s', (id, variant) => {
    expect(intelVariantForDeviceId(id)).toBe(variant)
  })

  it.each([
    ['Intel UHD Graphics 630', 'intel-legacy'],
    ['Intel HD Graphics 530', 'intel-legacy'],
    ['Intel UHD Graphics 770', 'intel'],
    ['Intel Arc A380', 'intel'],
    ['Intel UHD Graphics', null],
  ] as const)('Intel name %s -> %s', (name, variant) => {
    expect(intelVariantForName(name)).toBe(variant)
  })

  it.each([
    ['NVIDIA GeForce GTX 1060 6GB', 'nvidia-legacy'],
    ['NVIDIA GeForce GTX 970', 'nvidia-legacy'],
    ['Quadro P2000', 'nvidia-legacy'],
    ['NVIDIA GeForce GTX 1650', 'nvidia'],
    ['NVIDIA GeForce RTX 2060', 'nvidia'],
    ['NVIDIA L4', 'nvidia'],
  ] as const)('NVIDIA name %s -> %s', (name, variant) => {
    expect(nvidiaVariantForName(name)).toBe(variant)
  })
})
