import { describe, it, expect } from 'vitest'
import { defined } from '../../__tests__/support/vitest-mock.js'
import type { DetailStepAnnounce } from '@camstack/types'
import { DetailScheduler } from '../detail-scheduler.js'

function once(
  stepId: string,
  opts: Partial<DetailStepAnnounce['cadence']> = {},
): DetailStepAnnounce {
  return {
    stepId,
    inputClasses: ['person'],
    cadence: { trigger: 'once', maxPerTrack: 3, ...opts },
  }
}

function improve(
  stepId: string,
  opts: Partial<DetailStepAnnounce['cadence']> = {},
): DetailStepAnnounce {
  return {
    stepId,
    inputClasses: ['person'],
    cadence: { trigger: 'improve', ...opts },
  }
}

function periodic(
  stepId: string,
  opts: Partial<DetailStepAnnounce['cadence']> = {},
): DetailStepAnnounce {
  return {
    stepId,
    inputClasses: ['person'],
    cadence: { trigger: 'periodic', ...opts },
  }
}

describe('DetailScheduler', () => {
  describe('onTrackStarted', () => {
    it('fires new-track immediately for every announced step matching the class', () => {
      const scheduler = new DetailScheduler()
      const requests = scheduler.onTrackStarted(
        't1',
        'person',
        [once('face'), improve('clip'), periodic('reid')],
        1000,
      )
      expect(requests).toHaveLength(3)
      expect(requests.every((r) => r.reason === 'new-track')).toBe(true)
      expect(requests.map((r) => r.stepId).sort()).toEqual(['clip', 'face', 'reid'])
      expect(requests.every((r) => r.trackId === 't1')).toBe(true)
    })

    it('a step absent from the announce (class mismatch) never fires', () => {
      const scheduler = new DetailScheduler()
      const vehicleStep: DetailStepAnnounce = {
        stepId: 'vehicle-classifier',
        inputClasses: ['car', 'truck'],
        cadence: { trigger: 'once', maxPerTrack: 3 },
      }
      const requests = scheduler.onTrackStarted('t1', 'person', [vehicleStep], 1000)
      expect(requests).toHaveLength(0)

      // Confirm it stays silent for the rest of the lifecycle too.
      expect(scheduler.onCandidateImproved('t1', 2000)).toHaveLength(0)
      expect(scheduler.tick(3000)).toHaveLength(0)
    })

    it('unknown track id operations are no-ops, never throw', () => {
      const scheduler = new DetailScheduler()
      expect(() => scheduler.onTrackEnded('ghost')).not.toThrow()
      expect(scheduler.onCandidateImproved('ghost', 1000)).toEqual([])
      expect(() => scheduler.onResult('ghost', 'face', 0.9, 1000)).not.toThrow()
    })
  })

  describe('once trigger', () => {
    it('fires exactly once on track start and never again on tick/improve without a failed result', () => {
      const scheduler = new DetailScheduler()
      const requests = scheduler.onTrackStarted('t1', 'person', [once('face')], 1000)
      expect(requests).toHaveLength(1)
      expect(requests[0]).toEqual({ trackId: 't1', stepId: 'face', reason: 'new-track' })

      expect(scheduler.onCandidateImproved('t1', 1500)).toHaveLength(0)
      expect(scheduler.tick(2000)).toHaveLength(0)
      expect(scheduler.tick(5000)).toHaveLength(0)
    })

    it('retries via tick (reason retry) when result confidence is below stickyOnConfidence, up to maxPerTrack', () => {
      const scheduler = new DetailScheduler()
      scheduler.onTrackStarted(
        't1',
        'person',
        [once('face', { maxPerTrack: 3, stickyOnConfidence: 0.8 })],
        0,
      )
      // first fire consumed at t=0 (new-track), firedCount=1

      scheduler.onResult('t1', 'face', 0.3, 100) // below sticky threshold -> retry eligible

      // default backoff (minIntervalMs unset -> default 1000ms)
      expect(scheduler.tick(500)).toHaveLength(0)
      const retry1 = scheduler.tick(1200)
      expect(retry1).toHaveLength(1)
      expect(retry1[0]).toEqual({ trackId: 't1', stepId: 'face', reason: 'retry' })
      // firedCount now 2

      scheduler.onResult('t1', 'face', 0.2, 1300) // still below sticky -> retry eligible again
      expect(scheduler.tick(1900)).toHaveLength(0)
      const retry2 = scheduler.tick(2300)
      expect(retry2).toHaveLength(1)
      expect(defined(retry2[0], 'retry2[0]').reason).toBe('retry')
      // firedCount now 3 == maxPerTrack

      scheduler.onResult('t1', 'face', 0.1, 2400) // still failing, but maxPerTrack reached
      expect(scheduler.tick(4000)).toHaveLength(0)
      expect(scheduler.tick(10_000)).toHaveLength(0)
    })

    it('a null confidence result (failed attempt) is retried the same way as a low-confidence result', () => {
      const scheduler = new DetailScheduler()
      scheduler.onTrackStarted('t1', 'person', [once('face', { maxPerTrack: 2 })], 0)
      scheduler.onResult('t1', 'face', null, 100)
      const retry = scheduler.tick(1200)
      expect(retry).toHaveLength(1)
      expect(defined(retry[0], 'retry[0]').reason).toBe('retry')
    })

    it('a successful (non-null) result on a once step WITHOUT stickyOnConfidence is terminal — no retry', () => {
      const scheduler = new DetailScheduler()
      // No stickyOnConfidence → a non-null read (e.g. a plate) is success.
      scheduler.onTrackStarted('t1', 'person', [once('plate', { maxPerTrack: 3 })], 0)
      scheduler.onResult('t1', 'plate', 0.9, 100) // success — must NOT re-run the chain

      expect(scheduler.tick(1200)).toHaveLength(0)
      expect(scheduler.tick(5000)).toHaveLength(0)
      expect(scheduler.tick(10_000)).toHaveLength(0)
    })

    it('a null result on a once step WITHOUT stickyOnConfidence still retries', () => {
      const scheduler = new DetailScheduler()
      scheduler.onTrackStarted('t1', 'person', [once('plate', { maxPerTrack: 3 })], 0)
      scheduler.onResult('t1', 'plate', null, 100) // failed read — retry eligible

      const retry = scheduler.tick(1200)
      expect(retry).toHaveLength(1)
      expect(retry[0]).toEqual({ trackId: 't1', stepId: 'plate', reason: 'retry' })
    })

    it('a late result on an already-sticky step never re-arms retry', () => {
      const scheduler = new DetailScheduler()
      scheduler.onTrackStarted('t1', 'person', [once('face', { stickyOnConfidence: 0.8 })], 0)
      scheduler.onResult('t1', 'face', 0.9, 100) // → sticky

      // A stale/low-confidence result arrives afterwards (out-of-order).
      scheduler.onResult('t1', 'face', 0.1, 200)
      expect(scheduler.tick(2000)).toHaveLength(0)
      expect(scheduler.tick(10_000)).toHaveLength(0)
    })

    it('confidence >= stickyOnConfidence makes the step sticky — never fires again', () => {
      const scheduler = new DetailScheduler()
      scheduler.onTrackStarted('t1', 'person', [once('face', { stickyOnConfidence: 0.8 })], 0)
      scheduler.onResult('t1', 'face', 0.9, 100)

      expect(scheduler.tick(2000)).toHaveLength(0)
      expect(scheduler.onCandidateImproved('t1', 3000)).toHaveLength(0)
      expect(scheduler.tick(100_000)).toHaveLength(0)
    })
  })

  describe('improve trigger', () => {
    it('fires on start and again on onCandidateImproved, but never on tick', () => {
      const scheduler = new DetailScheduler()
      const startRequests = scheduler.onTrackStarted('t1', 'person', [improve('clip')], 0)
      expect(startRequests).toHaveLength(1)

      expect(scheduler.tick(1000)).toHaveLength(0)
      expect(scheduler.tick(5000)).toHaveLength(0)

      const improveRequests = scheduler.onCandidateImproved('t1', 6000)
      expect(improveRequests).toHaveLength(1)
      expect(improveRequests[0]).toEqual({ trackId: 't1', stepId: 'clip', reason: 'improve' })
    })

    it('respects minIntervalMs between improve fires', () => {
      const scheduler = new DetailScheduler()
      scheduler.onTrackStarted('t1', 'person', [improve('clip', { minIntervalMs: 2000 })], 0)

      expect(scheduler.onCandidateImproved('t1', 500)).toHaveLength(0) // too soon
      const fired = scheduler.onCandidateImproved('t1', 2100)
      expect(fired).toHaveLength(1)
      expect(scheduler.onCandidateImproved('t1', 2200)).toHaveLength(0) // too soon again
    })

    it('respects maxPerTrack across improve fires', () => {
      const scheduler = new DetailScheduler()
      scheduler.onTrackStarted('t1', 'person', [improve('clip', { maxPerTrack: 2 })], 0)
      // firedCount = 1 (new-track)
      const second = scheduler.onCandidateImproved('t1', 1000)
      expect(second).toHaveLength(1) // firedCount = 2 == max
      const third = scheduler.onCandidateImproved('t1', 2000)
      expect(third).toHaveLength(0)
    })

    it('stops firing after a sticky confidence result', () => {
      const scheduler = new DetailScheduler()
      scheduler.onTrackStarted('t1', 'person', [improve('clip', { stickyOnConfidence: 0.7 })], 0)
      scheduler.onResult('t1', 'clip', 0.9, 500)
      expect(scheduler.onCandidateImproved('t1', 1000)).toHaveLength(0)
    })

    it('does not fire for a step with trigger other than improve', () => {
      const scheduler = new DetailScheduler()
      scheduler.onTrackStarted(
        't1',
        'person',
        [once('face'), periodic('reid', { minIntervalMs: 500 })],
        0,
      )
      const requests = scheduler.onCandidateImproved('t1', 1000)
      expect(requests).toHaveLength(0)
    })
  })

  describe('periodic trigger', () => {
    it('fires on tick respecting minIntervalMs and stops after sticky confidence', () => {
      const scheduler = new DetailScheduler()
      scheduler.onTrackStarted(
        't1',
        'person',
        [periodic('reid', { minIntervalMs: 1000, stickyOnConfidence: 0.9 })],
        0,
      )
      // firedCount=1 at t=0 from new-track

      expect(scheduler.tick(500)).toHaveLength(0) // too soon since last fire (t=0)
      const fire1 = scheduler.tick(1100)
      expect(fire1).toHaveLength(1)
      expect(fire1[0]).toEqual({ trackId: 't1', stepId: 'reid', reason: 'periodic' })

      expect(scheduler.tick(1600)).toHaveLength(0) // too soon since fire1 (t=1100)
      const fire2 = scheduler.tick(2200)
      expect(fire2).toHaveLength(1)

      scheduler.onResult('t1', 'reid', 0.95, 2300) // sticky
      expect(scheduler.tick(10_000)).toHaveLength(0)
    })

    it('defaults minIntervalMs to 1000ms when unset', () => {
      const scheduler = new DetailScheduler()
      scheduler.onTrackStarted('t1', 'person', [periodic('reid')], 0)
      expect(scheduler.tick(999)).toHaveLength(0)
      expect(scheduler.tick(1000)).toHaveLength(1)
    })

    it('never fires on onCandidateImproved', () => {
      const scheduler = new DetailScheduler()
      scheduler.onTrackStarted('t1', 'person', [periodic('reid', { minIntervalMs: 100 })], 0)
      expect(scheduler.onCandidateImproved('t1', 5000)).toHaveLength(0)
    })

    it('respects maxPerTrack', () => {
      const scheduler = new DetailScheduler()
      scheduler.onTrackStarted(
        't1',
        'person',
        [periodic('reid', { minIntervalMs: 100, maxPerTrack: 2 })],
        0,
      )
      // firedCount=1 (new-track)
      const fire1 = scheduler.tick(200)
      expect(fire1).toHaveLength(1) // firedCount=2 == max
      const fire2 = scheduler.tick(400)
      expect(fire2).toHaveLength(0)
    })
  })

  describe('per-(track, step) isolation', () => {
    it('multiple tracks and multiple steps are scheduled independently', () => {
      const scheduler = new DetailScheduler()
      scheduler.onTrackStarted(
        't1',
        'person',
        [once('face'), periodic('reid', { minIntervalMs: 500 })],
        0,
      )
      scheduler.onTrackStarted('t2', 'person', [once('face')], 0)

      // t1's face is 'once' and already fired; onResult failing should not affect t2's face step.
      scheduler.onResult('t1', 'face', 0.1, 100)
      const t1Retry = scheduler.tick(1600)
      // only t1's face (retry) + t1's reid (periodic) should be present, not t2's face
      const t1Requests = t1Retry.filter((r) => r.trackId === 't1')
      const t2Requests = t1Retry.filter((r) => r.trackId === 't2')
      expect(t2Requests).toHaveLength(0)
      expect(t1Requests.length).toBeGreaterThan(0)
    })
  })

  describe('onTrackEnded', () => {
    it('clears all state for the track — subsequent calls are no-ops', () => {
      const scheduler = new DetailScheduler()
      scheduler.onTrackStarted('t1', 'person', [periodic('reid', { minIntervalMs: 100 })], 0)
      scheduler.onTrackEnded('t1')

      expect(scheduler.tick(1000)).toHaveLength(0)
      expect(scheduler.onCandidateImproved('t1', 1000)).toHaveLength(0)
      expect(() => scheduler.onResult('t1', 'reid', 0.9, 1000)).not.toThrow()
    })
  })

  describe('permanent frame-miss give-up (onFrameMiss)', () => {
    it('abandons a periodic step after N consecutive frame misses — no more retry requests', () => {
      // Reproduces the permanent-retry loop: a periodic step (maxPerTrack
      // defaults to Infinity) whose frame is gone re-arms retry forever. A
      // frame-plane miss ("frame + crop both missed") is fed via onFrameMiss and
      // must give up after MAX_CONSECUTIVE_FRAME_MISSES (3).
      const scheduler = new DetailScheduler()
      scheduler.onTrackStarted('t1', 'person', [periodic('face', { minIntervalMs: 0 })], 0)

      // miss #1 → retry re-armed (below give-up bound)
      scheduler.onFrameMiss('t1', 'face', 10)
      expect(scheduler.tick(20)).toHaveLength(1)

      // miss #2 → retry re-armed
      scheduler.onFrameMiss('t1', 'face', 30)
      expect(scheduler.tick(40)).toHaveLength(1)

      // miss #3 → step abandoned for this track (terminal)
      scheduler.onFrameMiss('t1', 'face', 50)
      expect(scheduler.tick(60)).toHaveLength(0)
      // never fires again, no matter how far the clock advances
      expect(scheduler.tick(100_000)).toHaveLength(0)
      expect(scheduler.onCandidateImproved('t1', 200_000)).toHaveLength(0)
    })

    it('resets the consecutive-miss counter on a resolved result — only CONSECUTIVE misses abandon', () => {
      // A resolved-but-empty result (onResult(null)) means the frame plane WORKED
      // (model just found nothing). It must break a run of frame misses so a
      // transient eviction never permanently abandons a still-live track.
      const scheduler = new DetailScheduler()
      scheduler.onTrackStarted('t1', 'person', [periodic('face', { minIntervalMs: 0 })], 0)

      scheduler.onFrameMiss('t1', 'face', 10) // 1
      scheduler.onFrameMiss('t1', 'face', 20) // 2
      scheduler.onResult('t1', 'face', null, 25) // frame resolved → counter reset

      scheduler.onFrameMiss('t1', 'face', 30) // 1 again (not 3)
      scheduler.onFrameMiss('t1', 'face', 40) // 2
      // still scheduling — NOT abandoned
      expect(scheduler.tick(50)).toHaveLength(1)
    })

    it('onFrameMiss on an unknown track/step is a no-op, never throws', () => {
      const scheduler = new DetailScheduler()
      expect(() => scheduler.onFrameMiss('ghost', 'face', 1000)).not.toThrow()
      scheduler.onTrackStarted('t1', 'person', [periodic('face')], 0)
      expect(() => scheduler.onFrameMiss('t1', 'unknown-step', 1000)).not.toThrow()
    })

    it('a frame miss on a sticky step is ignored (sticky stays terminal, never abandons/retries)', () => {
      const scheduler = new DetailScheduler()
      scheduler.onTrackStarted(
        't1',
        'person',
        [periodic('face', { minIntervalMs: 0, stickyOnConfidence: 0.8 })],
        0,
      )
      scheduler.onResult('t1', 'face', 0.9, 100) // → sticky
      scheduler.onFrameMiss('t1', 'face', 200)
      expect(scheduler.tick(1000)).toHaveLength(0)
    })
  })
})
