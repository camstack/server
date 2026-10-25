/**
 * AI-vision pre-annotation: what is asked, what is accepted back, and where
 * the frame goes.
 *
 * A model's answer is untrusted input. It is parsed against a strict shape;
 * a malformed answer is refused as a whole, and an individual object that is
 * out of the frame, of a class nobody asked for, or about a box nobody sent is
 * dropped and counted — never coerced into a box on the canvas.
 */
import { describe, expect, it } from 'vitest'
import {
  buildLlmAssistRequest,
  llmProfileLeavesHouse,
  parseLlmAssistAnswer,
} from '../retrain-llm-assist.js'

const CLASSES = ['person', 'vehicle'] as const

describe('llmProfileLeavesHouse', () => {
  it('cloud vendors leave the house; the local runtimes do not', () => {
    expect(llmProfileLeavesHouse({ kind: 'openai' })).toBe(true)
    expect(llmProfileLeavesHouse({ kind: 'anthropic' })).toBe(true)
    expect(llmProfileLeavesHouse({ kind: 'google' })).toBe(true)
    expect(llmProfileLeavesHouse({ kind: 'managed-local' })).toBe(false)
    expect(llmProfileLeavesHouse({ kind: 'apple-foundation' })).toBe(false)
  })

  it('an OpenAI-compatible endpoint is judged by its host', () => {
    const at = (baseUrl: string) => llmProfileLeavesHouse({ kind: 'openai-compatible', baseUrl })
    expect(at('http://192.168.1.40:1234/v1')).toBe(false)
    expect(at('http://10.0.0.5/v1')).toBe(false)
    expect(at('http://172.20.1.1/v1')).toBe(false)
    expect(at('http://localhost:11434/v1')).toBe(false)
    expect(at('http://127.0.0.1:8080')).toBe(false)
    expect(at('http://[::1]:8080')).toBe(false)
    expect(at('http://lmstudio.local:1234')).toBe(false)
    expect(at('http://mac-mini:1234')).toBe(false)
    expect(at('https://api.groq.com/openai/v1')).toBe(true)
    expect(at('http://172.32.0.1/v1')).toBe(true)
    // No URL, or one that does not parse: assume it leaves — the safe answer.
    expect(llmProfileLeavesHouse({ kind: 'openai-compatible' })).toBe(true)
    expect(at('not a url')).toBe(true)
  })
})

describe('buildLlmAssistRequest', () => {
  it('names the classes, the frame size and every box to review, by ref', () => {
    const request = buildLlmAssistRequest({
      classes: [...CLASSES],
      width: 1920,
      height: 1080,
      boxes: [
        {
          ref: 'b1',
          bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
          macroClass: 'person',
          label: 'postman',
        },
      ],
    })
    expect(request.prompt).toContain('person, vehicle')
    expect(request.prompt).toContain('1920×1080')
    expect(request.prompt).toContain('"ref":"b1"')
    expect(request.system.length).toBeGreaterThan(50)
    expect(request.jsonSchema).toMatchObject({ type: 'object', required: ['objects', 'reviews'] })
  })
})

describe('parseLlmAssistAnswer', () => {
  const refs = new Set(['b1'])

  it('accepts a well-formed answer, including one wrapped in a code fence', () => {
    const text = [
      '```json',
      JSON.stringify({
        objects: [
          { class: 'person', box: [0.1, 0.1, 0.2, 0.5], confidence: 0.8, reason: 'a walker' },
          {
            class: 'vehicle',
            label: 'van',
            box: [0.5, 0.5, 0.4, 0.3],
            confidence: 0.6,
            reason: 'white van',
          },
        ],
        reviews: [{ ref: 'b1', verdict: 'not-an-object', reason: 'this is a plant' }],
      }),
      '```',
    ].join('\n')
    const parsed = parseLlmAssistAnswer(text, { classes: [...CLASSES], refs })
    expect(parsed.kind).toBe('parsed')
    if (parsed.kind !== 'parsed') return
    expect(parsed.objects).toHaveLength(2)
    expect(parsed.objects[1]).toMatchObject({
      macroClass: 'vehicle',
      label: 'van',
      bbox: { x: 0.5, y: 0.5, w: 0.4, h: 0.3 },
      confidence: 0.6,
      reason: 'white van',
    })
    expect(parsed.reviews).toEqual([
      { ref: 'b1', verdict: 'not-an-object', reason: 'this is a plant' },
    ])
    expect(parsed.rejected).toBe(0)
  })

  it('refuses an answer that is not JSON or not the schema', () => {
    expect(parseLlmAssistAnswer('I see two people.', { classes: [...CLASSES], refs }).kind).toBe(
      'malformed',
    )
    expect(
      parseLlmAssistAnswer(JSON.stringify({ objects: 'none' }), { classes: [...CLASSES], refs })
        .kind,
    ).toBe('malformed')
    expect(
      parseLlmAssistAnswer(JSON.stringify({ objects: [], reviews: [], extra: 1 }), {
        classes: [...CLASSES],
        refs,
      }).kind,
    ).toBe('malformed')
  })

  it('drops — and counts — an object out of the frame, of an unasked class, or a review of an unknown box', () => {
    const text = JSON.stringify({
      objects: [
        {
          class: 'person',
          box: [0.9, 0.1, 0.3, 0.2],
          confidence: 0.9,
          reason: 'runs off the edge',
        },
        { class: 'animal', box: [0.1, 0.1, 0.1, 0.1], confidence: 0.9, reason: 'not asked' },
        { class: 'person', box: [0.1, 0.1, 0, 0.1], confidence: 0.9, reason: 'no width' },
        { class: 'person', box: [0.1, 0.1, 0.1, 0.1], confidence: 1.5, reason: 'bad score' },
        {
          class: 'person',
          box: [0.1, 0.1, 0.1, 0.1],
          confidence: 0.4,
          reason: 'ok',
          label: 'Person',
        },
      ],
      reviews: [
        { ref: 'nope', verdict: 'confirmed', reason: 'unknown box' },
        { ref: 'b1', verdict: 'wrong-class', suggestedClass: 'vehicle', reason: 'a car' },
      ],
    })
    const parsed = parseLlmAssistAnswer(text, { classes: [...CLASSES], refs })
    if (parsed.kind !== 'parsed') throw new Error('expected parsed')
    expect(parsed.objects).toHaveLength(1)
    // A macro word is never a label.
    expect(parsed.objects[0]).not.toHaveProperty('label')
    expect(parsed.reviews).toEqual([
      { ref: 'b1', verdict: 'wrong-class', suggestedClass: 'vehicle', reason: 'a car' },
    ])
    expect(parsed.rejected).toBe(5)
  })
})
