// @vitest-environment jsdom
/**
 * plus catalog API key lives inline under Catalog → plus catalog (one authority, D62).
 * Write-only: malformed keys rejected client-side; with a key the account
 * catalog renders model group → release and every family card at once.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AddonPageProps } from '@camstack/ui-library'
import fixture from './testdata/plus-catalog-model-list.json'
import { toPlusModelSummaries } from '../plus-catalog/plus-catalog-api.js'
import { PlusCatalogSection } from '../tabs/PlusCatalogSourceSections.js'

const PLUS_LIST = toPlusModelSummaries(fixture)
const VALID_KEY = `${'a'.repeat(8)}-${'b'.repeat(4)}-${'c'.repeat(4)}-${'d'.repeat(4)}-${'e'.repeat(12)}:${'f'.repeat(40)}`

interface FakeTrpcState {
  configured: boolean
  updateCalls: unknown[]
  actionCalls: string[]
  actionInputs?: { action: string; input: unknown }[]
}

function fakeTrpc(
  state: FakeTrpcState,
  opts: { readonly tfliteNodes?: readonly string[] } = {},
): AddonPageProps['trpc'] {
  const surface = {
    addons: {
      custom: {
        mutate: async (input: { addonId: string; action: string; input: unknown }) => {
          state.actionCalls.push(input.action)
          state.actionInputs?.push({
            action: input.action,
            input: input.input,
          })
          if (input.action === 'importPlusCatalogModel') {
            return {
              ok: true,
              modelId: 'plus-catalog-x',
              bytes: 4_000_000,
              conversions: [],
            }
          }
          if (input.action === 'plusCatalogPlusStatus') {
            return { configured: state.configured, keyFormatValid: state.configured }
          }
          if (input.action === 'plusCatalogPlusTest') return { ok: true }
          if (input.action === 'plusCatalogPlusListModels') return PLUS_LIST
          if (input.action === 'tfliteSupport') return { nodes: opts.tfliteNodes ?? ['hub'] }
          if (input.action === 'listCustomModels') return []
          if (input.action === 'listAvailability') return {}
          throw new Error(`unexpected action ${input.action}`)
        },
      },
    },
    live: {
      onEvent: { subscribe: () => ({ unsubscribe: () => {} }) },
    },
    addonSettings: {
      updateGlobalSettings: {
        mutate: async (input: unknown) => {
          state.updateCalls.push(input)
          state.configured = true
          return { ok: true }
        },
      },
    },
  }
  return surface as unknown as AddonPageProps['trpc']
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('PlusCatalogSection — plus catalog key inline in Catalog', () => {
  it('without a key shows the inline key field (not Settings)', async () => {
    const state: FakeTrpcState = { configured: false, updateCalls: [], actionCalls: [] }
    render(
      <PlusCatalogSection
        trpc={fakeTrpc(state)}
        onRegistered={() => {}}
        onError={() => {}}
        onPrefillUpload={() => {}}
      />,
    )

    expect(await screen.findByLabelText(/plus catalog API key/i)).toBeTruthy()
    const input = (await screen.findByLabelText(/plus catalog API key/i)) as HTMLInputElement
    expect(input.type).toBe('password')
    expect(screen.queryByRole('button', { name: /open settings/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /manage key in settings/i })).toBeNull()
  })

  it('rejects a malformed key with ZERO network writes', async () => {
    const state: FakeTrpcState = { configured: false, updateCalls: [], actionCalls: [] }
    render(
      <PlusCatalogSection
        trpc={fakeTrpc(state)}
        onRegistered={() => {}}
        onError={() => {}}
        onPrefillUpload={() => {}}
      />,
    )

    const input = (await screen.findByLabelText(/plus catalog API key/i)) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'not-a-key' } })
    fireEvent.click(screen.getByRole('button', { name: /save key/i }))

    expect(await screen.findByText(/does not match the documented/i)).toBeTruthy()
    expect(state.updateCalls).toEqual([])
  })

  it('saves a valid key through addonSettings.updateGlobalSettings (the ONE authority)', async () => {
    const state: FakeTrpcState = { configured: false, updateCalls: [], actionCalls: [] }
    render(
      <PlusCatalogSection
        trpc={fakeTrpc(state)}
        onRegistered={() => {}}
        onError={() => {}}
        onPrefillUpload={() => {}}
      />,
    )

    const input = (await screen.findByLabelText(/plus catalog API key/i)) as HTMLInputElement
    fireEvent.change(input, { target: { value: VALID_KEY } })
    fireEvent.click(screen.getByRole('button', { name: /save key/i }))

    await waitFor(() => {
      expect(state.updateCalls).toEqual([
        { addonId: 'model-studio', patch: { plusCatalogPlusApiKey: VALID_KEY } },
      ])
    })
    await waitFor(() => {
      expect(state.actionCalls).toContain('plusCatalogPlusTest')
    })
    expect(await screen.findByText(/API key.*configured|configured.*API key/i)).toBeTruthy()
  })

  it('when configured shows badge + Replace — never the key value', async () => {
    const state: FakeTrpcState = { configured: true, updateCalls: [], actionCalls: [] }
    render(
      <PlusCatalogSection
        trpc={fakeTrpc(state)}
        onRegistered={() => {}}
        onError={() => {}}
        onPrefillUpload={() => {}}
      />,
    )

    expect(await screen.findByText(/API key.*configured|configured.*API key/i)).toBeTruthy()
    expect(screen.queryByLabelText(/plus catalog API key/i)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /replace key/i }))
    const input = (await screen.findByLabelText(/plus catalog API key/i)) as HTMLInputElement
    expect(input.type).toBe('password')
    expect(input.value).toBe('')
  })

  it('with a key, renders model group → release and NO runtime selector', async () => {
    const state: FakeTrpcState = {
      configured: true,
      updateCalls: [],
      actionCalls: [],
    }
    render(
      <PlusCatalogSection
        trpc={fakeTrpc(state)}
        onRegistered={() => {}}
        onError={() => {}}
        onPrefillUpload={() => {}}
      />,
    )

    const release = (await screen.findByLabelText(/plus catalog release/i)) as HTMLSelectElement
    expect([...release.options].every((o) => /^\d{4}\.\d+$/.test(o.value))).toBe(true)

    expect(screen.queryByLabelText(/Runtime/i)).toBeNull()
    expect(screen.queryByText(/Neural \(ONNX/i)).toBeNull()
    expect(screen.queryByLabelText(/Detector build/i)).toBeNull()
    expect(screen.getByRole('button', { name: /replace key/i })).toBeTruthy()

    const familyCard = await screen.findByTestId('source-family-card')
    expect(familyCard.getAttribute('data-family')).toBe('yolov9')
    expect(screen.getAllByRole('button', { name: /^Import$/i }).length).toBeGreaterThanOrEqual(1)
  })

  it('base 2026.1 shows YOLO-NAS, YOLOv9 and MobileDet cards at once', async () => {
    const state: FakeTrpcState = {
      configured: true,
      updateCalls: [],
      actionCalls: [],
    }
    render(
      <PlusCatalogSection
        trpc={fakeTrpc(state)}
        onRegistered={() => {}}
        onError={() => {}}
        onPrefillUpload={() => {}}
      />,
    )
    fireEvent.change(await screen.findByLabelText(/Model group/i), { target: { value: 'base' } })
    fireEvent.change(await screen.findByLabelText(/plus catalog release/i), {
      target: { value: '2026.1' },
    })
    await waitFor(() => {
      const families = screen
        .getAllByTestId('source-family-card')
        .map((c) => c.getAttribute('data-family'))
      expect(families.toSorted()).toEqual(['mobiledet', 'yolonas', 'yolov9'])
    })
  })

  it('MobileDet offers only TFLite, gated on the Coral; YOLOv9 lists formats per combination', async () => {
    const state: FakeTrpcState = {
      configured: true,
      updateCalls: [],
      actionCalls: [],
    }
    render(
      <PlusCatalogSection
        trpc={fakeTrpc(state)}
        onRegistered={() => {}}
        onError={() => {}}
        onPrefillUpload={() => {}}
      />,
    )
    fireEvent.change(await screen.findByLabelText(/Model group/i), {
      target: { value: 'base' },
    })
    fireEvent.change(await screen.findByLabelText(/plus catalog release/i), {
      target: { value: '2026.1' },
    })

    const panelFor = async (combo: string) =>
      waitFor(() => {
        const panel = screen
          .getAllByTestId('plus-combo-panel')
          .find((p) => p.getAttribute('data-combo') === combo)
        if (panel === undefined) throw new Error(`no panel for ${combo}`)
        return panel
      })

    const mobiledet = await panelFor('mobiledet-320')
    expect(within(mobiledet).getByText('TFLite')).toBeTruthy()
    expect(within(mobiledet).queryByText('ONNX')).toBeNull()
    expect(within(mobiledet).queryByText('OpenVINO')).toBeNull()
    expect(await within(mobiledet).findByText(/Coral \(tflite\) node available/i)).toBeTruthy()

    // The YOLOv9 card defaults to its first chip; pick Small · 320 explicitly.
    const yolov9 = screen
      .getAllByTestId('source-family-card')
      .find((c) => c.getAttribute('data-family') === 'yolov9')
    if (yolov9 === undefined) throw new Error('no yolov9 card')
    const panel = within(yolov9).getByTestId('plus-combo-panel')
    const combo = panel.getAttribute('data-combo')
    const expected: Readonly<Record<string, readonly string[]>> = {
      'yolov9s-320': ['ONNX', 'OpenVINO', 'CoreML', 'TFLite'],
      'yolov9s-640': ['ONNX', 'OpenVINO', 'CoreML'],
      'yolov9t-640': ['ONNX', 'OpenVINO', 'CoreML'],
    }
    const labels = ['ONNX', 'OpenVINO', 'CoreML', 'TFLite'].filter(
      (l) => within(panel).queryByText(l) !== null,
    )
    expect(labels).toEqual(expected[combo ?? ''])
  })

  it('without a Coral node the TFLite format is blocked with the reason, never an Import', async () => {
    const state: FakeTrpcState = {
      configured: true,
      updateCalls: [],
      actionCalls: [],
    }
    render(
      <PlusCatalogSection
        trpc={fakeTrpc(state, { tfliteNodes: [] })}
        onRegistered={() => {}}
        onError={() => {}}
        onPrefillUpload={() => {}}
      />,
    )
    fireEvent.change(await screen.findByLabelText(/Model group/i), {
      target: { value: 'base' },
    })
    fireEvent.change(await screen.findByLabelText(/plus catalog release/i), {
      target: { value: '2026.1' },
    })
    const mobiledet = await waitFor(() => {
      const card = screen
        .getAllByTestId('source-family-card')
        .find((c) => c.getAttribute('data-family') === 'mobiledet')
      if (card === undefined) throw new Error('no mobiledet card')
      return card
    })
    expect(await within(mobiledet).findByText(/needs a Coral/i)).toBeTruthy()
    expect(within(mobiledet).queryByRole('button', { name: /^Import$/i })).toBeNull()
  })

  it('Import on the MobileDet TFLite downloads THAT EdgeTPU build as tflite, with the typed name', async () => {
    const state: FakeTrpcState = {
      configured: true,
      updateCalls: [],
      actionCalls: [],
      actionInputs: [],
    }
    render(
      <PlusCatalogSection
        trpc={fakeTrpc(state)}
        onRegistered={() => {}}
        onError={() => {}}
        onPrefillUpload={() => {}}
      />,
    )
    fireEvent.change(await screen.findByLabelText(/Model group/i), {
      target: { value: 'base' },
    })
    fireEvent.change(await screen.findByLabelText(/plus catalog release/i), {
      target: { value: '2026.1' },
    })
    const mobiledet = await waitFor(() => {
      const card = screen
        .getAllByTestId('source-family-card')
        .find((c) => c.getAttribute('data-family') === 'mobiledet')
      if (card === undefined) throw new Error('no mobiledet card')
      return card
    })
    fireEvent.change(within(mobiledet).getByLabelText(/Display name/i), {
      target: { value: '  Coral   person  ' },
    })
    fireEvent.click(await within(mobiledet).findByRole('button', { name: /^Import$/i }))
    await waitFor(() => {
      const call = state.actionInputs?.find((c) => c.action === 'importPlusCatalogModel')
      expect(call?.input).toEqual({
        plusModelId: 'e39924321',
        name: 'Coral person',
        ensureFormats: [],
        format: 'tflite',
      })
    })
  })
})
