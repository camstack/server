import { describe, expect, it } from 'vitest'
import {
  PACKAGE_LLM_SILENCE_STREAK,
  PackageLlmSilence,
  type PackageLlmSilenceNote,
} from '../package-llm-silence.js'

const DEVICE = 615

function note(latencyMs: number): PackageLlmSilenceNote {
  return { deviceId: DEVICE, reason: 'timeout', detail: 'timeout', latencyMs }
}

describe('package llm silence', () => {
  it('opens one edge on the streak and stays quiet until an answer', () => {
    const silence = new PackageLlmSilence()
    const edges = []
    for (let i = 0; i < PACKAGE_LLM_SILENCE_STREAK + 2; i += 1) {
      const edge = silence.noteUncertain(note(8_000 + i))
      if (edge !== null) edges.push(edge)
    }
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({
      phase: 'silent',
      note: {
        deviceId: DEVICE,
        reason: 'timeout',
        latencyMs: 8_000 + PACKAGE_LLM_SILENCE_STREAK - 1,
      },
    })
    expect(silence.noteAnswered(DEVICE)).toEqual({ phase: 'answered', deviceId: DEVICE })
    expect(silence.noteAnswered(DEVICE)).toBeNull()
  })

  it('a yes or no before the streak resets it', () => {
    const silence = new PackageLlmSilence()
    expect(silence.noteUncertain(note(1))).toBeNull()
    expect(silence.noteAnswered(DEVICE)).toBeNull()
    for (let i = 0; i < PACKAGE_LLM_SILENCE_STREAK - 1; i += 1) {
      expect(silence.noteUncertain(note(2))).toBeNull()
    }
    expect(silence.noteUncertain(note(3))?.phase).toBe('silent')
  })

  it('forget drops an open edge without a recovery', () => {
    const silence = new PackageLlmSilence()
    for (let i = 0; i < PACKAGE_LLM_SILENCE_STREAK; i += 1) silence.noteUncertain(note(1))
    silence.forget(DEVICE)
    expect(silence.noteAnswered(DEVICE)).toBeNull()
  })
})
