/**
 * D14/D549 § 7 gate: does the framework-derived device-config section reach a
 * camera whose binding entry is **wrapped**?
 *
 * Every `deviceConfig.ui.kind:'widget'` cap shipped so far (`ptz`,
 * `motion-zones`, `privacy-mask`, `stream-params`, …) is `deviceNative: true`,
 * so every run of `deriveDeviceConfigContribution` in production has been over
 * a `kind:'native'` entry. `videoclips` is the first that is not: it is a
 * `kind:'wrapper'` cap, so its binding entry arrives as `kind:'wrapped'` with
 * `providerAddonId` naming the WRAPPER addon (post-analysis today, Reolink
 * beside it tomorrow).
 *
 * D549's consequences say this must be VERIFIED rather than assumed, because
 * the cost of it being false is a `DeviceDetail.tsx` hand-placement — the
 * exact thing D14 exists to prevent. Pinned here so a future narrowing of the
 * derive path (a `kind === 'native'` guard added for any reason) fails loudly
 * instead of silently deleting the Clips tab.
 *
 * The section is asserted field by field because the widget only renders when
 * ALL of them survive: `location:'top-tab'` (from `topTab`), the `tab` id the
 * router keys on, and the `widgetId` `WidgetSlot` resolves through
 * `HOST_WIDGETS`.
 */
import type {
  AddonContext,
  DeviceBindingEntry,
  ICapabilityRegistry,
  IScopedLogger,
} from '@camstack/types'
import { isDeviceConfigCap, videoclipsCapability } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { deriveDeviceConfigContribution } from '../device-aggregation.js'
import type { AggregationDeps } from '../device-aggregation.js'

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

/** The derive path for a `widget` ui reads NOTHING off deps but the logger. */
function makeDeps(): AggregationDeps {
  return { ctx: { logger: makeLogger() } as unknown as AddonContext } as AggregationDeps
}

/** A registry the widget branch never consults — proof it does not have to. */
const NO_REGISTRY = {
  getDefinition: () => undefined,
  getProviderForDevice: () => null,
} as unknown as ICapabilityRegistry

const WRAPPED: DeviceBindingEntry = {
  capName: 'videoclips',
  kind: 'wrapped',
  providerAddonId: 'post-analysis',
  providerNodeId: 'hub',
  nativeAddonId: '',
}

describe('deriveDeviceConfigContribution — a WRAPPED binding entry', () => {
  it('videoclips declares a device-config widget at all', () => {
    expect(isDeviceConfigCap(videoclipsCapability)).toBe(true)
  })

  it('emits the widget section for a wrapped entry, exactly as for a native one', async () => {
    const def = videoclipsCapability
    if (!isDeviceConfigCap(def)) throw new Error('videoclips lost its deviceConfig declaration')

    const wrapped = await deriveDeviceConfigContribution(
      makeDeps(),
      NO_REGISTRY,
      def,
      WRAPPED,
      592,
      'settings',
    )
    expect(wrapped).not.toBeNull()
    const section = wrapped?.sections[0]
    expect(section?.id).toBe('videoclips-widget')
    // The clips widget is a SECTION at the end of the Recording tab, never a
    // tab of its own — the placement the operator asked for (D557).
    expect(section?.tab).toBe('recording')
    expect(section?.location).toBe('top-tab')
    expect(section?.fields[0]).toMatchObject({
      type: 'widget',
      widgetId: 'host/clips-browser',
    })

    // Same input with `kind:'native'` — the two answers are identical, which
    // is the claim: the derive is binding-entry shaped, not binding-KIND shaped.
    const native = await deriveDeviceConfigContribution(
      makeDeps(),
      NO_REGISTRY,
      def,
      { ...WRAPPED, kind: 'native' },
      592,
      'settings',
    )
    expect(native).toEqual(wrapped)
  })

  it('contributes nothing to the LIVE aggregate', async () => {
    const def = videoclipsCapability
    if (!isDeviceConfigCap(def)) throw new Error('videoclips lost its deviceConfig declaration')
    expect(
      await deriveDeviceConfigContribution(makeDeps(), NO_REGISTRY, def, WRAPPED, 107, 'live'),
    ).toBeNull()
  })
})
