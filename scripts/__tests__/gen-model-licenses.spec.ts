/**
 * The licence surfaces are generated from the catalogs (D661):
 * THIRD_PARTY_MODELS.md and the HF model table. These pin what the generator
 * derives, so a catalog fact cannot be lost on the way to a surface.
 */
import { describe, expect, it } from 'vitest'
import { buildRows, renderHfTable, renderNotice } from '../gen-model-licenses.js'

describe('gen-model-licenses', () => {
  const rows = buildRows()

  it('covers every catalog id exactly once', () => {
    const ids = rows.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('yolo26n')
    expect(ids).toContain('siglip2-b16-224-text')
    expect(ids).toContain('llm-llama3.2-3b-instruct-q4')
  })

  it('marks step defaults, and only them', () => {
    expect(rows.find((r) => r.id === 'yolo26n')?.isDefault).toBe(true)
    expect(rows.find((r) => r.id === 'yunet-2023mar')?.isDefault).toBe(true)
    expect(rows.find((r) => r.id === 'yolo26x')?.isDefault).toBe(false)
    expect(rows.find((r) => r.id === 'yolov9s-320-edgetpu')?.isDefault).toBe(true)
    expect(rows.find((r) => r.id === 'ssd-mobilenet-v2-coco-edgetpu')?.isDefault).toBe(false)
    expect(rows.find((r) => r.id === 'ssdlite-mobiledet-coco-edgetpu')).toBeUndefined()
  })

  it('names the steps a model serves', () => {
    expect(rows.find((r) => r.id === 'auraface-r100')?.steps).toEqual(['face-embedding'])
    expect(rows.find((r) => r.id === 'siglip2-b16-224-text')?.steps).toEqual(['clip-text'])
  })

  it('the notice carries every required attribution verbatim', () => {
    const notice = renderNotice(rows)
    expect(notice).toContain('Built with Llama')
    expect(notice).toContain('CC BY-NC 4.0')
    for (const r of rows) if (r.attribution !== null) expect(notice).toContain(r.attribution)
  })

  it('the notice lists every non-commercial model in its own section', () => {
    const notice = renderNotice(rows)
    const section = notice.slice(notice.indexOf('## Non-commercial models'))
    for (const r of rows.filter((x) => x.nonCommercial)) expect(section).toContain(`\`${r.id}\``)
  })

  it('the HF table lists only CamStack-hosted rows', () => {
    const table = renderHfTable(rows)
    expect(table).toContain('yolo26n')
    expect(table).not.toContain('ssd-mobilenet-v2-coco-edgetpu')
    expect(table).not.toContain('llm-qwen2.5-1.5b-instruct-q4')
  })

  it('renders byte-identically twice (the --check contract)', () => {
    expect(renderNotice(buildRows())).toBe(renderNotice(rows))
  })
})
