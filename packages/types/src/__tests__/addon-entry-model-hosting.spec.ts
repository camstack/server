/**
 * The model downloader (inside `@camstack/system/addon-utils`) reads the hosting
 * constants from `@camstack/types/addon`, never the schema barrel (D28). The
 * light entry must carry the same VALUES the barrel does.
 */
import { describe, expect, it } from 'vitest'
import * as addon from '../addon.js'
import * as barrel from '../index.js'

describe('@camstack/types/addon model-hosting surface', () => {
  it('exports HF_REPO, MODEL_FORMATS and hfModelUrl identical to the barrel', () => {
    expect(addon.HF_REPO).toBe(barrel.HF_REPO)
    expect(addon.MODEL_FORMATS).toBe(barrel.MODEL_FORMATS)
    expect(addon.hfModelUrl).toBe(barrel.hfModelUrl)
    expect(addon.hfModelUrl(addon.HF_REPO, 'a/b.onnx')).toBe(
      'https://huggingface.co/camstack/camstack-models/resolve/main/a/b.onnx',
    )
  })
})
