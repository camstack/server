// @vitest-environment jsdom
/**
 * D214 addendum — WITHOUT a plus catalog key the plus catalog source is the honest
 * fallback: the publicly downloadable plus catalog default (MobileDet EdgeTPU),
 * the explanation that a key unlocks the real account catalog, and the
 * Prefill-Upload utility. No invented families, no empty selects.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AddonPageProps } from '@camstack/ui-library'
import { PlusCatalogSection, type UploadPrefill } from '../tabs/PlusCatalogSourceSections.js'

function fakeTrpc(tfliteNodes: readonly string[] = ['hub']): AddonPageProps['trpc'] {
  const surface = {
    addons: {
      custom: {
        mutate: async (input: { action: string }) => {
          if (input.action === 'plusCatalogPlusStatus') {
            return { configured: false, keyFormatValid: false }
          }
          if (input.action === 'tfliteSupport') {
            return { nodes: tfliteNodes }
          }
          throw new Error(`unexpected action ${input.action}`)
        },
      },
    },
    addonSettings: { updateGlobalSettings: { mutate: async () => ({ ok: true }) } },
  }
  return surface as unknown as AddonPageProps['trpc']
}

afterEach(cleanup)

describe('PlusCatalogSection — no-key fallback', () => {
  it('explains the key unlock and offers ONLY the publicly downloadable plus catalog default', async () => {
    render(
      <PlusCatalogSection
        trpc={fakeTrpc()}
        onRegistered={() => {}}
        onError={() => {}}
        onPrefillUpload={() => {}}
      />,
    )
    // The key unlock is the inline plus catalog key panel (Catalog → plus catalog):
    // it says what the key is for and offers the write-only form.
    expect(await screen.findByText(/Required to list your account models/i)).toBeTruthy()
    expect(screen.getByPlaceholderText(/xxxxxxxx-xxxx/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /save key/i })).toBeTruthy()
    expect(screen.getByText(/Public default \(no key required\)/i)).toBeTruthy()
    expect(screen.getByText(/MobileDet/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /import \+ land on hub|register/i })).toBeTruthy()
    // The invented, non-downloadable families are GONE.
    expect(screen.queryByText(/YOLO-NAS/)).toBeNull()
    expect(screen.queryByText(/YOLOv9/)).toBeNull()
  })

  it('a tflite model is GATED on Coral availability: no tflite node → import disabled with the reason', async () => {
    render(
      <PlusCatalogSection
        trpc={fakeTrpc([])}
        onRegistered={() => {}}
        onError={() => {}}
        onPrefillUpload={() => {}}
      />,
    )
    const btn = (await screen.findByRole('button', {
      name: /import \+ land|^register$/i,
    })) as HTMLButtonElement
    await screen.findByText(/no Coral/i)
    expect(btn.disabled).toBe(true)
  })

  it('with a Coral node present, the tflite import is enabled and names the node', async () => {
    render(
      <PlusCatalogSection
        trpc={fakeTrpc(['hub'])}
        onRegistered={() => {}}
        onError={() => {}}
        onPrefillUpload={() => {}}
      />,
    )
    const btn = (await screen.findByRole('button', {
      name: /import \+ land on hub/i,
    })) as HTMLButtonElement
    await screen.findByText(/Coral \(tflite\) node available: hub/i)
    expect(btn.disabled).toBe(false)
  })

  it('the Prefill Upload utility hands the verified MobileDet characteristics to the generic flow', async () => {
    const prefills: UploadPrefill[] = []
    render(
      <PlusCatalogSection
        trpc={fakeTrpc()}
        onRegistered={() => {}}
        onError={() => {}}
        onPrefillUpload={(p) => prefills.push(p)}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: /prefill custom/i }))
    expect(prefills).toHaveLength(1)
    expect(prefills[0]).toMatchObject({ format: 'tflite', postprocessor: 'ssd', inputSize: 320 })
    expect(prefills[0]!.labels[0]).toBe('person')
  })
})
