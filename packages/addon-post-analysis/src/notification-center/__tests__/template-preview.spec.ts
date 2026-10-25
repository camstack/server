import { NcTemplatePreviewInputSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { previewTemplate } from '../template-preview.js'
import { NcTextCatalog } from '../text-catalog.js'

describe('previewTemplate', () => {
  const it_ = new NcTextCatalog({ language: 'it' })

  it('renders declared variables with their examples', () => {
    const out = previewTemplate(it_, {
      context: { family: 'rule', field: 'title', kind: 'occupancy' },
      template: { title: '{{scope}}: {{count}}/{{capacity}}' },
    })
    expect(out.title).toBe('Cancello: 3/2')
    expect(out.body).toBeNull()
    expect(out.unknown).toEqual([])
  })

  it('renders composites and the clock through the real catalog, in ITS language', () => {
    const en = new NcTextCatalog({ language: 'en' })
    const draft = {
      context: { family: 'rule', field: 'body', kind: 'occupancy' },
      template: { body: '{{op}} @ {{time}}' },
    } as const
    // `occupancy.op.occupied` in texts/it.json vs texts/en.json, and the
    // fixed preview instant through `ncClockText` in each language.
    expect(previewTemplate(it_, draft).body).toBe('occupata @ 20:05')
    expect(previewTemplate(en, draft).body).toMatch(/^occupied @ 08:05\s?PM$/)
  })

  it('names the variables this context cannot fill, and renders them empty', () => {
    const out = previewTemplate(it_, {
      context: { family: 'rule', field: 'title', kind: 'detection' },
      template: { title: '{{camera}} {{capacity}} {{tiles}}' },
    })
    expect(out.unknown).toEqual(['capacity', 'tiles'])
    expect(out.title).toBe('Front door  ')
  })

  it('accepts a D637 family kind on the wire and previews with that family’s variables', () => {
    // The hub's input enum carries the new kinds; the served catalog still
    // says `system`, and the match covers every system kind.
    const input = NcTemplatePreviewInputSchema.parse({
      context: { family: 'rule', field: 'body', kind: 'device-events' },
      template: { body: '{{percentage}}% {{mode}}' },
    })
    const out = previewTemplate(it_, input)
    // No event kind chosen: a device-events rule has the battery `percentage`
    // and not the alarm's `mode`.
    expect(out.unknown).toEqual(['mode'])
    for (const kind of ['system', 'alarm', 'mixed'] as const) {
      expect(() =>
        NcTemplatePreviewInputSchema.parse({
          context: { family: 'rule', field: 'body', kind },
          template: { body: '{{eventKind}}' },
        }),
      ).not.toThrow()
    }
  })

  it('accepts count_<class> where the family declares it', () => {
    const out = previewTemplate(it_, {
      context: { family: 'summary', field: 'body' },
      template: { body: '{{count_car}} auto' },
    })
    expect(out.unknown).toEqual([])
    expect(out.body).toBe('3 auto')
  })
})
