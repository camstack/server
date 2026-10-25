/**
 * The face threshold is chosen from a MEASUREMENT of the gallery the matcher
 * will actually serve (D651): genuine pairs (two samples of one person) and
 * impostor pairs (samples of two people), in ONE model's space, and the
 * threshold is the lowest bar that lets at most the stated fraction of
 * impostor pairs through.
 *
 * What these specs pin is what makes the number honest:
 *  - one model per measurement — a mixed gallery is two cosine spaces;
 *  - the false-accept target is met exactly, or the report says it could not
 *    be resolved with this many impostor pairs;
 *  - a measurement that cannot be taken is `null` with a reason, never 0.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  calibrateFaceThreshold,
  decodeVectorBase64,
  authenticateHub,
  resolveHubConnection,
  type CalibrationSample,
} from '../face-threshold-calibration.js'

/** A unit vector at `deg` degrees in the plane: cos(a − b) is the pair's cosine. */
function at(deg: number): readonly number[] {
  const r = (deg * Math.PI) / 180
  return [Math.cos(r), Math.sin(r)]
}

function sample(
  identityId: string,
  sampleId: string,
  deg: number,
  modelId = 'auraface-r100',
): CalibrationSample {
  return { identityId, sampleId, modelId, embedding: at(deg) }
}

// Two people, three samples each. Genuine pairs sit within 20°, impostors 80°+.
const GALLERY: readonly CalibrationSample[] = [
  sample('anna', 'a1', 0),
  sample('anna', 'a2', 10),
  sample('anna', 'a3', 20),
  sample('bruno', 'b1', 100),
  sample('bruno', 'b2', 110),
  sample('bruno', 'b3', 120),
]

describe('calibrateFaceThreshold', () => {
  it('counts every genuine and impostor pair once', () => {
    const r = calibrateFaceThreshold(GALLERY, { modelId: 'auraface-r100', falseAcceptTarget: 0 })
    // 3 choose 2, twice; and 3 × 3 across the two people.
    expect(r.genuine.count).toBe(6)
    expect(r.impostor.count).toBe(9)
  })

  it('puts the threshold just above the highest impostor when no false accept is allowed', () => {
    const r = calibrateFaceThreshold(GALLERY, { modelId: 'auraface-r100', falseAcceptTarget: 0 })
    const maxImpostor = Math.cos((80 * Math.PI) / 180) // a3 ~ b1
    expect(r.threshold).not.toBeNull()
    expect(r.threshold!).toBeGreaterThan(maxImpostor)
    expect(r.threshold! - maxImpostor).toBeLessThanOrEqual(0.001)
    expect(r.falseAcceptRate).toBe(0)
    // Every genuine pair (cos 20° = 0.94 at worst) clears it.
    expect(r.falseRejectRate).toBe(0)
  })

  it('meets a non-zero target exactly: k of n impostor pairs above the bar, never k + 1', () => {
    // 9 impostor pairs; 0.12 allows floor(1.08) = 1 through.
    const r = calibrateFaceThreshold(GALLERY, { modelId: 'auraface-r100', falseAcceptTarget: 0.12 })
    expect(r.falseAcceptRate).toBeCloseTo(1 / 9)
    expect(r.falseAcceptRate!).toBeLessThanOrEqual(0.12)
    expect(r.targetResolvable).toBe(true)
  })

  it('says when the target is finer than the impostor pairs can resolve', () => {
    // 1 / 9 = 0.111: a 0.1% target cannot be told apart from 0 with 9 pairs.
    const r = calibrateFaceThreshold(GALLERY, {
      modelId: 'auraface-r100',
      falseAcceptTarget: 0.001,
    })
    expect(r.targetResolvable).toBe(false)
    expect(r.resolution).toBeCloseTo(1 / 9)
    // It still answers, conservatively: above every impostor seen.
    expect(r.falseAcceptRate).toBe(0)
  })

  it('measures ONE model: samples of any other model are excluded and counted, never mixed in', () => {
    const mixed = [...GALLERY, sample('anna', 'a-old', 100, 'arcface-r100')]
    const r = calibrateFaceThreshold(mixed, { modelId: 'auraface-r100', falseAcceptTarget: 0 })
    // a-old sits exactly on bruno's b1: mixed in, it would be a genuine pair
    // at cos(100°) and pull the genuine tail far below the impostor max.
    expect(r.genuine.count).toBe(6)
    expect(r.excludedOtherModels).toEqual({ 'arcface-r100': 1 })
    expect(r.falseRejectRate).toBe(0)
  })

  it('is null with a reason when there are no impostor pairs (one person)', () => {
    const r = calibrateFaceThreshold(
      GALLERY.filter((s) => s.identityId === 'anna'),
      { modelId: 'auraface-r100', falseAcceptTarget: 0 },
    )
    expect(r.threshold).toBeNull()
    expect(r.falseAcceptRate).toBeNull()
    expect(r.reason).toMatch(/impostor/)
  })

  it('is null with a reason when no person has two samples (no genuine pair)', () => {
    const r = calibrateFaceThreshold([sample('anna', 'a1', 0), sample('bruno', 'b1', 100)], {
      modelId: 'auraface-r100',
      falseAcceptTarget: 0,
    })
    expect(r.threshold).toBeNull()
    expect(r.falseRejectRate).toBeNull()
    expect(r.reason).toMatch(/genuine/)
  })

  it('is null with a reason when the model has no sample at all', () => {
    const r = calibrateFaceThreshold(GALLERY, { modelId: 'arcface-r100', falseAcceptTarget: 0 })
    expect(r.threshold).toBeNull()
    expect(r.reason).toMatch(/arcface-r100/)
  })

  it('drops a sample whose dimension disagrees with the rest, and says so', () => {
    const odd: CalibrationSample = {
      identityId: 'anna',
      sampleId: 'a-3d',
      modelId: 'auraface-r100',
      embedding: [1, 0, 0],
    }
    const r = calibrateFaceThreshold([...GALLERY, odd], {
      modelId: 'auraface-r100',
      falseAcceptTarget: 0,
    })
    expect(r.genuine.count).toBe(6)
    expect(r.excludedDimension).toBe(1)
  })

  it('reports the distributions it decided from', () => {
    const r = calibrateFaceThreshold(GALLERY, { modelId: 'auraface-r100', falseAcceptTarget: 0 })
    expect(r.genuine.min).toBeCloseTo(Math.cos((20 * Math.PI) / 180))
    expect(r.impostor.max).toBeCloseTo(Math.cos((80 * Math.PI) / 180))
    expect(r.impostor.p50).not.toBeNull()
  })

  it('a zero-norm vector is unmeasurable: excluded and counted, never scored as cosine 0', () => {
    const zero: CalibrationSample = {
      identityId: 'bruno',
      sampleId: 'b-zero',
      modelId: 'auraface-r100',
      embedding: [0, 0],
    }
    const r = calibrateFaceThreshold([...GALLERY, zero], {
      modelId: 'auraface-r100',
      falseAcceptTarget: 0,
    })
    // Scored as 0 it would add 3 impostor and 3 genuine pairs.
    expect(r.impostor.count).toBe(9)
    expect(r.genuine.count).toBe(6)
    expect(r.skipped).toBe(1)
    expect(r.samples).toBe(6)
  })

  it('a non-finite component is unmeasurable too', () => {
    const nan: CalibrationSample = {
      identityId: 'anna',
      sampleId: 'a-nan',
      modelId: 'auraface-r100',
      embedding: [Number.NaN, 1],
    }
    const r = calibrateFaceThreshold([...GALLERY, nan], {
      modelId: 'auraface-r100',
      falseAcceptTarget: 0,
    })
    expect(r.skipped).toBe(1)
    expect(r.genuine.count).toBe(6)
  })

  it('refuses a target outside [0, 1)', () => {
    expect(() =>
      calibrateFaceThreshold(GALLERY, { modelId: 'auraface-r100', falseAcceptTarget: 1 }),
    ).toThrow(/falseAcceptTarget/)
  })
})

describe('decodeVectorBase64', () => {
  it('reads the little-endian float32 the vector store serves', () => {
    const floats = new Float32Array([0.5, -0.25, 1])
    const b64 = Buffer.from(floats.buffer).toString('base64')
    expect(decodeVectorBase64(b64)).toEqual([0.5, -0.25, 1])
  })

  it('is null for a blob that is not whole float32s — never a zero vector', () => {
    expect(decodeVectorBase64(Buffer.from([1, 2, 3]).toString('base64'))).toBeNull()
    expect(decodeVectorBase64('')).toBeNull()
  })
})

describe('resolveHubConnection — no hub address lives in the repo', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))

  it('takes the hub URL from CAMSTACK_HUB_URL', () => {
    const c = resolveHubConnection({
      env: { CAMSTACK_HUB_URL: 'https://hub.example:4443/' },
      repoRoot: '/repo',
      readFile: () => null,
    })
    expect(c.hubUrl).toBe('https://hub.example:4443')
    // No implicit token file: the session is the credential.
    expect(c.tokenFile).toBeUndefined()
  })

  it('falls back to a gitignored scratchpad/.hub file', () => {
    const c = resolveHubConnection({
      env: {},
      repoRoot: '/repo',
      readFile: (p) => (p === path.join('/repo', 'scratchpad', '.hub') ? 'https://h:1\n' : null),
    })
    expect(c.hubUrl).toBe('https://h:1')
  })

  it('REFUSES by name when neither is set — there is no built-in default', () => {
    expect(() =>
      resolveHubConnection({ env: {}, repoRoot: '/repo', readFile: () => null }),
    ).toThrow(/CAMSTACK_HUB_URL/)
  })

  it('takes the token file from CAMSTACK_HUB_TOKEN_FILE when set', () => {
    const c = resolveHubConnection({
      env: { CAMSTACK_HUB_URL: 'https://h:1', CAMSTACK_HUB_TOKEN_FILE: '/elsewhere/.tok' },
      repoRoot: '/repo',
      readFile: () => null,
    })
    expect(c.tokenFile).toBe('/elsewhere/.tok')
  })

  it('the token comes from the shared resolver (the session), never from a file read here', async () => {
    const asked: { server?: string; tokenFile?: string }[] = []
    const auth = await authenticateHub({ hubUrl: 'https://h:1' }, async (opts) => {
      asked.push(opts)
      return { server: 'https://h:1', token: 'session-jwt' }
    })
    expect(asked).toEqual([{ server: 'https://h:1' }])
    expect(auth).toEqual({ hubUrl: 'https://h:1', token: 'session-jwt' })
    const src = readFileSync(path.join(here, '..', 'face-threshold-calibration.ts'), 'utf8')
    expect(src).not.toMatch(/\.tok\b|admin-token/)
  })

  it('an explicit CAMSTACK_HUB_TOKEN_FILE is passed through as an override only', async () => {
    const asked: { server?: string; tokenFile?: string }[] = []
    await authenticateHub({ hubUrl: 'https://h:1', tokenFile: '/x/t' }, async (opts) => {
      asked.push(opts)
      return { server: 'https://h:1', token: 't' }
    })
    expect(asked).toEqual([{ server: 'https://h:1', tokenFile: '/x/t' }])
  })

  it('the script source carries no IP address', () => {
    const src = readFileSync(path.join(here, '..', 'face-threshold-calibration.ts'), 'utf8')
    expect(src).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/)
  })
})
