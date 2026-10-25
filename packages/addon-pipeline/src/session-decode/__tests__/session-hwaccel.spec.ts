/**
 * The session decoder tries only the hwaccel backends the node's resolver
 * OFFERS (D926).
 *
 * Measured 2026-10-23 (intel-1.2.509): libva could not initialise the iHD
 * driver, yet every session decode worker tried `vaapi` then `qsv` from its own
 * fixed list and logged a failure each time — 722 lines a day. The kernel
 * resolver now withholds a backend libva cannot open (one ERROR at resolve
 * time); the worker must follow it rather than rediscover the failure per
 * session.
 */
import type { IKernelHwAccel } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  isSessionHwaccelOffer,
  SessionHwaccelSource,
  sessionDecodeCandidates,
} from '../session-hwaccel.js'

function resolver(answer: IKernelHwAccel['resolve']): IKernelHwAccel {
  return { resolve: answer }
}

describe('sessionDecodeCandidates', () => {
  it('a node whose VA init failed (resolver offers nothing) tries no hardware', () => {
    expect(sessionDecodeCandidates('linux', [])).toEqual([])
  })

  it('keeps the decode order (vaapi before qsv) among what the resolver offers', () => {
    expect(sessionDecodeCandidates('linux', ['qsv', 'vaapi'])).toEqual(['vaapi', 'qsv'])
  })

  it('an NVIDIA node whose VA failed keeps cuda only', () => {
    expect(sessionDecodeCandidates('linux', ['cuda', 'nvdec'])).toEqual(['cuda'])
  })

  it('an unresolved offer (null) falls back to the platform order — the old behaviour', () => {
    expect(sessionDecodeCandidates('linux', null)).toEqual(['vaapi', 'qsv', 'cuda'])
    expect(sessionDecodeCandidates('darwin', null)).toEqual(['videotoolbox'])
  })
})

describe('isSessionHwaccelOffer', () => {
  it('accepts null and lists of known backends, refuses anything else', () => {
    expect(isSessionHwaccelOffer(null)).toBe(true)
    expect(isSessionHwaccelOffer([])).toBe(true)
    expect(isSessionHwaccelOffer(['vaapi', 'cuda'])).toBe(true)
    expect(isSessionHwaccelOffer(['openvino'])).toBe(false)
    expect(isSessionHwaccelOffer(undefined)).toBe(false)
    expect(isSessionHwaccelOffer('vaapi')).toBe(false)
  })
})

describe('SessionHwaccelSource', () => {
  it('is null (unresolved) until the resolver answered', () => {
    expect(new SessionHwaccelSource().current()).toBeNull()
  })

  it('holds the resolver auto-answer after a refresh', async () => {
    const src = new SessionHwaccelSource()
    const asked: unknown[] = []
    await src.refresh(
      resolver(async (prefer) => {
        asked.push(prefer)
        return { preferred: [], rationale: 'vaapi: init-failed (…)' }
      }),
    )
    expect(src.current()).toEqual([])
    expect(asked).toEqual([null])
  })

  it('a failed resolve changes nothing — the last answer stands', async () => {
    const src = new SessionHwaccelSource()
    await src.refresh(resolver(async () => ({ preferred: ['qsv', 'vaapi'], rationale: '' })))
    await src.refresh(
      resolver(async () => {
        throw new Error('boom')
      }),
    )
    expect(src.current()).toEqual(['qsv', 'vaapi'])
  })

  it('no resolver on this node leaves the offer unresolved', async () => {
    const src = new SessionHwaccelSource()
    await src.refresh(undefined)
    expect(src.current()).toBeNull()
  })
})
