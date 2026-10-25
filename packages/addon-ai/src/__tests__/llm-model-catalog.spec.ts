/**
 * The catalogue's shape — the invariants an added or removed model can break.
 *
 * Written on 2026-09-02 after discovering that NOTHING pinned the exposed list:
 * deleting two entries from `LLM_MODEL_CATALOG` left all 250 tests green, so
 * the catalogue could lose a model without a single assertion noticing.
 *
 * These are properties, not a copy of the list. Asserting the names would fail
 * on every legitimate addition and get deleted the first time someone adds a
 * model; asserting what a model must HAVE survives the list changing.
 */
import { describe, expect, it } from 'vitest'
import { LLM_MODEL_CATALOG, catalogById } from '../runtime/llm-model-catalog.js'

const GIB = 1024 ** 3
const vision = LLM_MODEL_CATALOG.filter((m) => m.meta.purpose === 'vision')

describe('the managed-model catalogue', () => {
  it('every entry is verifiable — a download with no sha256 cannot be checked', () => {
    for (const m of LLM_MODEL_CATALOG) {
      expect(m.meta.sha256, `${m.meta.id} has no sha256`).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('every VISION entry ships a projector, and ships it as a file to fetch', () => {
    // A vision model without its mmproj loads and then cannot see — the failure
    // is a model that answers confidently about an image it never received.
    for (const m of vision) {
      expect(m.meta.mmprojUrl, `${m.meta.id} declares no mmproj`).toBeTruthy()
      const extra = m.entry.extraFiles ?? []
      expect(
        extra.some((f) => f.url === m.meta.mmprojUrl),
        `${m.meta.id} declares an mmproj the installer never downloads`,
      ).toBe(true)
    }
  })

  it('the two halves of an entry agree on its id', () => {
    for (const m of LLM_MODEL_CATALOG) {
      expect(m.entry.id, `${m.meta.id} disagrees with its entry`).toBe(m.meta.id)
      expect(catalogById(m.meta.id)?.meta.id).toBe(m.meta.id)
    }
  })

  it('the vision ladder has a rung a mid-size node can hold', () => {
    // The reason the 4B and 8B were added: the catalogue jumped from ~2 GB to a
    // 35B MoE, and the operator was running an 8B through an EXTERNAL endpoint
    // because nothing in between was offered. A future cleanup that removes the
    // middle without noticing re-opens exactly that hole.
    const light = vision.filter((m) => m.meta.minRamBytes <= 4 * GIB)
    const middle = vision.filter(
      (m) => m.meta.minRamBytes > 4 * GIB && m.meta.minRamBytes <= 8 * GIB,
    )
    expect(light.length, 'no vision model a small node can hold').toBeGreaterThan(0)
    expect(middle.length, 'the 2B→35B gap is back').toBeGreaterThan(0)
  })

  it('declares no model whose weights are smaller than its projector', () => {
    // SmolVLM2 left on 2026-09-02 partly for this: 872 MB of projector against
    // 1.11 GB of weights, i.e. 44% of the download bought no parameters.
    for (const m of vision) {
      const proj = (m.entry.extraFiles ?? []).find((f) => f.url === m.meta.mmprojUrl)
      const weights = m.entry.formats.gguf
      if (proj === undefined || weights === undefined) continue
      expect(weights.sizeMB, `${m.meta.id}: the projector is most of the download`).toBeGreaterThan(
        proj.sizeMB,
      )
    }
  })
})
