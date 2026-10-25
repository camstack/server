import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

interface ManifestExecution {
  readonly heapProfile?: string
  readonly maxOldSpaceMb?: number
  readonly rssBudgetMb?: number
}
interface ManifestAddonEntry {
  readonly id?: string
  readonly execution?: ManifestExecution
}
interface PackageManifest {
  readonly camstack?: { readonly addons?: readonly ManifestAddonEntry[] }
}

/**
 * `pipeline-analytics` is a STATEFUL STORE ENGINE, not a light control-plane
 * addon: it owns the tracks store (37MB), event media rows (174k) and
 * motion-events (160k), and consumes every pipeline event on the hub. Measured
 * 2026-08-17 it sat at 667→725MB RSS and grew within the hour — while
 * classified light, i.e. with a 2MB young generation forcing constant
 * scavenges on a high-allocation consumer. The classification was wrong, not
 * the bound (the bound follows the class: V8-default young gen, the heavy
 * old-space ceiling, and the heavy-runner heap watch + stranded-page
 * reclaimer). This guard pins the class so a manifest edit cannot silently
 * revert it.
 */
describe('pipeline-analytics manifest heap class', () => {
  const manifestPath = join(__dirname, '..', '..', '..', 'package.json')
  const manifest: PackageManifest = JSON.parse(
    readFileSync(manifestPath, 'utf8'),
  ) as PackageManifest

  it('declares heapProfile heavy — it is a store engine, not a control-plane addon', () => {
    const entry = manifest.camstack?.addons?.find((a) => a.id === 'pipeline-analytics')
    expect(entry).toBeDefined()
    expect(entry?.execution?.heapProfile).toBe('heavy')
  })

  it('takes the heavy-class DEFAULT ceiling — no maxOldSpaceMb opt-out', () => {
    // The uncapped (`maxOldSpaceMb: 0`) escape hatch is for the media path,
    // where a flat cap turned a stall backlog into a fatal. Analytics is not
    // on the frame path; its working set fits comfortably under the class
    // default, and the ceiling is the guard against a real leak.
    const entry = manifest.camstack?.addons?.find((a) => a.id === 'pipeline-analytics')
    expect(entry?.execution?.maxOldSpaceMb).toBeUndefined()
  })

  /**
   * ## The ceiling above was in force for the entire climb to 11.4GB
   *
   * 2026-08-27 14:57Z the host's GLOBAL OOM killer took this runner at 11.4GB of
   * anon-rss (`dmesg`: `total-vm:13708084kB anon-rss:11397408kB`), stalling the
   * whole container for ~154s — every hub runner recorded `loopMax` 152-158s in
   * the same sample. Its profile shortly before: `rss=5735MB heapUsed=536MB
   * external=4264MB arrayBuffers=2315MB`.
   *
   * `--max-old-space-size=1024` was set the whole time and bounded a 536MB heap
   * perfectly. **96% of the growth was never V8's to bound**, and the watchdog's
   * `stranded` metric subtracts `external` by construction, so it was flat while
   * `rss` quadrupled. Nothing warned, once.
   *
   * 2048MB is the declared budget: this addon is an event aggregator with no
   * legitimate multi-GB working set (its heap is a third of its own ceiling), so
   * 2048 is generous against what it should hold and 5.5x below the number that
   * took the host down.
   */
  it('declares a 2048MB RSS budget — the ceiling above cannot see what killed it', () => {
    const entry = manifest.camstack?.addons?.find((a) => a.id === 'pipeline-analytics')
    expect(entry?.execution?.rssBudgetMb).toBe(2048)
  })
})
