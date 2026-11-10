import { describe, expect, it } from 'vitest'
import { renderAuthoredDeviceTemplates } from '../../device-template-pass.js'
import { renderTemplate } from '../../render-template.js'
import { NcTextCatalog } from '../../text-catalog.js'
import {
  buildSummaryOutboxInputs,
  type SummaryDeliveryInput,
  summaryCaptionText,
  summaryRecordId,
} from '../summary-delivery.js'

const WINDOW = {
  startMs: Date.UTC(2026, 7, 13, 5, 0),
  endMs: Date.UTC(2026, 7, 13, 7, 0),
}

function makeInput(over: Partial<SummaryDeliveryInput> = {}): SummaryDeliveryInput {
  return {
    texts: new NcTextCatalog(),
    ruleId: 'rule-1',
    ruleName: 'Notte',
    window: WINDOW,
    deviceIds: [636, 637, 1441],
    primaryDeviceId: 636,
    targets: [{ targetId: 'zentik-1' }, { targetId: 'zentik-2' }],
    priority: 3,
    tileCount: 5,
    cameraCount: 3,
    matchedCount: 5,
    generatedAt: WINDOW.endMs + 60_000,
    ...over,
  }
}

/**
 * The row as the dispatcher treats it: the device-template pass (a fake hub that knows one
 * value) over the authored text, then the final `{{var}}` pass that restores hidden braces.
 */
async function deliveredAs(
  template: { readonly title?: string; readonly body?: string } | undefined,
): Promise<{ readonly title: string; readonly body: string }> {
  const render = async (templates: readonly string[]) =>
    templates.map((source) => ({
      ok: true as const,
      text: source.replaceAll('{{ door.state }}', 'open'),
      trace: [],
    }))
  const [title, body] = await renderAuthoredDeviceTemplates(
    [template?.title, template?.body],
    render,
  )
  return {
    title: renderTemplate(title?.template, {}) ?? '',
    body: renderTemplate(body?.template, {}) ?? '',
  }
}

describe('summaryRecordId', () => {
  it('carries NO camera — a window is cross-camera and dedups once', () => {
    expect(summaryRecordId('rule-1', 999)).toBe('summary:rule-1:999')
  })
})

describe('buildSummaryOutboxInputs', () => {
  it('emits one row per target, all with the same record id', () => {
    const rows = buildSummaryOutboxInputs(makeInput())
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((r) => r.recordId)).size).toBe(1)
    expect(rows.every((r) => r.recordKind === 'ai-summary')).toBe(true)
    expect(rows.every((r) => r.deviceId === 636)).toBe(true)
    expect(rows.every((r) => r.payload.delivery === 'ai-summary')).toBe(true)
    // No media ladder: a digest owns no track, and asking for one would log
    // "no still could be resolved" on every single delivery.
    expect(rows.every((r) => r.payload.media === 'none')).toBe(true)
  })

  it('skips targets the owner opted out of', () => {
    const rows = buildSummaryOutboxInputs(makeInput({ disabledTargetIds: ['zentik-2'] }))
    expect(rows.map((r) => r.targetId)).toEqual(['zentik-1'])
  })

  it('renders the derived body with real plurals and the window', () => {
    const rows = buildSummaryOutboxInputs(makeInput({ tileCount: 1, cameraCount: 1 }))
    const body = rows[0]?.payload.template?.body ?? ''
    expect(body).toContain('1 event')
    expect(body).not.toContain('1 events')
    expect(body).toContain('1 camera')
    expect(body).not.toContain('1 cameras')
  })

  it('says nothing about truncation when the budget did not bite', () => {
    const notCut = buildSummaryOutboxInputs(makeInput({ tileCount: 9, matchedCount: 9 }))
    expect(notCut[0]?.payload.template?.body).not.toContain('most relevant')
    const cut = buildSummaryOutboxInputs(makeInput({ tileCount: 9, matchedCount: 40 }))
    expect(cut[0]?.payload.template?.body).toContain('showing the 9 most relevant of 40')
  })

  it('an empty window says so rather than printing a zero count', () => {
    const rows = buildSummaryOutboxInputs(
      makeInput({ tileCount: 0, cameraCount: 0, matchedCount: 0 }),
    )
    const body = rows[0]?.payload.template?.body ?? ''
    expect(body).toContain('nothing was seen')
    expect(body).not.toContain('0 events')
  })

  it("an operator's own template wins over the derived body", () => {
    const rows = buildSummaryOutboxInputs(
      makeInput({
        template: {
          title: '{{rule}} ({{cameras}})',
          body: '{{events}} passaggi',
        },
      }),
    )
    expect(rows[0]?.payload.template?.title).toBe('Notte (3)')
    expect(rows[0]?.payload.template?.body).toBe('5 passaggi')
  })

  it('attaches the mosaic as a URL, never as bytes', () => {
    const rows = buildSummaryOutboxInputs(
      makeInput({
        mosaic: {
          url: 'https://hub/x.jpg',
          mime: 'image/jpeg',
          name: 'summary.jpg',
        },
      }),
    )
    expect(rows[0]?.payload.artifacts).toEqual([
      {
        mediaType: 'image',
        url: 'https://hub/x.jpg',
        mime: 'image/jpeg',
        name: 'summary.jpg',
      },
    ])
  })

  it('delivers with no attachment at all when no public link could be minted', () => {
    const rows = buildSummaryOutboxInputs(makeInput())
    expect(rows[0]?.payload).not.toHaveProperty('artifacts')
    expect(rows[0]?.payload.template?.body).toBeTruthy()
  })

  it('fills clickUrl only where the operator did not set one', () => {
    const rows = buildSummaryOutboxInputs(
      makeInput({
        clickUrl: 'https://hub/viewer',
        targets: [{ targetId: 'a' }, { targetId: 'b', params: { clickUrl: 'https://mine' } }],
      }),
    )
    expect(rows[0]?.payload.params?.['clickUrl']).toBe('https://hub/viewer')
    expect(rows[1]?.payload.params?.['clickUrl']).toBe('https://mine')
  })
})

describe('the AI sentence in the body (P2)', () => {
  const AI = 'Two people walked up the drive and left through the gate.'

  it('LEADS the derived body — it is the part worth reading first', () => {
    const rows = buildSummaryOutboxInputs(makeInput({ aiText: AI }))
    const body = rows[0]?.payload.template?.body ?? ''
    expect(body.startsWith(AI)).toBe(true)
    // …and the counts are still there, on their own line.
    expect(body).toContain('5 events')
  })

  it('a digest with no AI text is BYTE-FOR-BYTE what P1 delivered', () => {
    // The fail-open promise, asserted rather than described: an unreachable
    // model must change nothing about the notification.
    const withAi = buildSummaryOutboxInputs(makeInput({ aiText: undefined }))
    const p1 = buildSummaryOutboxInputs(makeInput())
    expect(withAi[0]?.payload.template?.body).toBe(p1[0]?.payload.template?.body)
    expect(p1[0]?.payload.template?.body ?? '').not.toContain('\n')
  })

  it('an empty or whitespace sentence is treated as no sentence', () => {
    const blank = buildSummaryOutboxInputs(makeInput({ aiText: '   ' }))
    expect(blank[0]?.payload.template?.body).toBe(
      buildSummaryOutboxInputs(makeInput())[0]?.payload.template?.body,
    )
  })

  it('an operator template can PLACE it with {{ai}}', () => {
    const rows = buildSummaryOutboxInputs(
      makeInput({ aiText: AI, template: { body: 'Riepilogo: {{ai}} ({{events}})' } }),
    )
    expect(rows[0]?.payload.template?.body).toBe(`Riepilogo: ${AI} (5)`)
  })

  it('a template that NEVER names {{ai}} still gets the sentence appended', () => {
    // The alternative is an operator who switches AI on, has an old custom
    // body, and sees nothing change — a feature that looks broken because a
    // template written months earlier could not have mentioned it.
    const rows = buildSummaryOutboxInputs(
      makeInput({ aiText: AI, template: { body: '{{events}} passaggi' } }),
    )
    expect(rows[0]?.payload.template?.body).toBe(`5 passaggi\n${AI}`)
  })

  it('{{ai}} renders EMPTY, not literally, when the model gave nothing', () => {
    const rows = buildSummaryOutboxInputs(makeInput({ template: { body: 'x{{ai}}y' } }))
    expect(rows[0]?.payload.template?.body).toBe('xy')
  })

  it('the TITLE is never rewritten by the model', () => {
    // A lock-screen title is the one string an operator scans; it stays the
    // rule's own words whatever the model said.
    const rows = buildSummaryOutboxInputs(makeInput({ aiText: AI }))
    expect(rows[0]?.payload.template?.title).not.toContain(AI)
  })
})

describe('summaryCaptionText', () => {
  it('derives a caption when the rule names none', () => {
    expect(summaryCaptionText({ ruleName: 'Notte', window: WINDOW })).toMatch(/^Notte — \d\d:\d\d→/)
  })
  it('keeps an EMPTY caption as a real answer', () => {
    expect(
      summaryCaptionText({
        captionText: '',
        ruleName: 'Notte',
        window: WINDOW,
      }),
    ).toBe('')
  })
  it('renders the operator vocabulary', () => {
    expect(
      summaryCaptionText({
        captionText: '{{rule}} {{from}}-{{to}}',
        ruleName: 'N',
        window: WINDOW,
      }),
    ).toMatch(/^N \d\d:\d\d-\d\d:\d\d$/)
  })
})

describe('a digest row and the dispatcher device-template pass', () => {
  it('renders the operator-authored device value, and keeps a camera name and the AI text as data', async () => {
    const rows = buildSummaryOutboxInputs(
      makeInput({
        ruleName: 'Gate {{ door.state }}',
        aiText: 'A person at {{ door.state }} and {% x %}',
        template: {
          title: '{{rule}} / {{ door.state }}',
          body: 'door {{ door.state }}: {{ai}}',
        },
      }),
    )
    const delivered = await deliveredAs(rows[0]?.payload.template)
    expect(delivered.title).toBe('Gate {{ door.state }} / open')
    expect(delivered.body).toBe('door open: A person at {{ door.state }} and {% x %}')
  })

  it('a stray brace in the AI text does not get the authored template refused', async () => {
    const rows = buildSummaryOutboxInputs(
      makeInput({ aiText: 'a {{ broken', template: { title: 't', body: 'x {{ door.state }}' } }),
    )
    const [, body] = await renderAuthoredDeviceTemplates(
      [rows[0]?.payload.template?.title, rows[0]?.payload.template?.body],
      async (templates) =>
        templates.map((source) =>
          source.includes('{{ broken')
            ? {
                ok: false as const,
                refusal: { reason: 'syntax' as const, message: 'x' },
                trace: [],
              }
            : { ok: true as const, text: source, trace: [] },
        ),
    )
    expect(body?.refused).toBeUndefined()
  })

  it('catalog sentences stay data too: a camera named like a template prints as written', async () => {
    const rows = buildSummaryOutboxInputs(makeInput({ ruleName: '{{ door.state }}' }))
    const delivered = await deliveredAs(rows[0]?.payload.template)
    expect(delivered.title).not.toContain('open')
    expect(delivered.body).not.toContain('open')
  })
})
