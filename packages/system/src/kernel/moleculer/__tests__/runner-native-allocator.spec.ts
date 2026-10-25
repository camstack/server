import { describe, expect, it } from 'vitest'
import { applyRunnerNativeAllocator } from '../runner-native-allocator.js'

/**
 * Once the image entrypoint exports the pair, OMITTING it stops being enough.
 *
 * The kill switch works today only because the parent does not have the
 * variables: returning `{}` means the child never sees them. The moment the
 * entrypoint welds them into the container environment — which is what lets the
 * operator drop them from the Unraid template — the child INHERITS them, and a
 * switch that only omits is a switch that does nothing.
 *
 * So the kill switch deletes. And it deletes ONLY on the explicit switch: an
 * operator who set `VIPS_CONCURRENCY` by hand still owns it, and the non-linux
 * path (where the pin is a pure throughput cut, measured 6 → 1 on the darwin
 * agent) must not silently remove a value someone chose.
 */
describe('the kill switch removes what the parent already exported', () => {
  const welded = {
    MALLOC_ARENA_MAX: '2',
    VIPS_CONCURRENCY: '1',
    PATH: '/usr/bin',
  } as NodeJS.ProcessEnv

  it('deletes both keys when the switch is off, leaving the rest alone', () => {
    const out = applyRunnerNativeAllocator(
      { ...welded, CAMSTACK_RUNNER_NATIVE_ALLOCATOR: 'off' },
      'linux',
    )
    expect('MALLOC_ARENA_MAX' in out).toBe(false)
    expect('VIPS_CONCURRENCY' in out).toBe(false)
    expect(out['PATH']).toBe('/usr/bin')
  })

  it('keeps the welded values when the switch is not set', () => {
    const out = applyRunnerNativeAllocator(welded, 'linux')
    expect(out['MALLOC_ARENA_MAX']).toBe('2')
    expect(out['VIPS_CONCURRENCY']).toBe('1')
  })

  it('applies the defaults when the parent exported nothing', () => {
    const out = applyRunnerNativeAllocator({ PATH: '/usr/bin' }, 'linux')
    expect(out['MALLOC_ARENA_MAX']).toBe('2')
    expect(out['VIPS_CONCURRENCY']).toBe('1')
  })

  it('off linux, leaves an operator-set value alone instead of deleting it', () => {
    const out = applyRunnerNativeAllocator(welded, 'darwin')
    expect(out['MALLOC_ARENA_MAX']).toBe('2')
    expect(out['VIPS_CONCURRENCY']).toBe('1')
  })
})
