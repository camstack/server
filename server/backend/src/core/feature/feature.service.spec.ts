import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as yaml from 'js-yaml'
import { FeatureService } from './feature.service'
import { ConfigService } from '../config/config.service'
import type { FeatureManifest } from '@camstack/types'

/**
 * Test-only ConfigService subclass that overrides the `features` getter
 * to return a fixed manifest. Avoids wiring a full settings-store just to
 * drive a FeatureService. The bootstrap YAML still has to be real so the
 * ConfigManager constructor succeeds.
 */
class StaticFeatureConfigService extends ConfigService {
  constructor(
    configPath: string,
    private readonly staticFeatures: FeatureManifest,
  ) {
    super(configPath)
  }

  override get features(): FeatureManifest {
    return this.staticFeatures
  }
}

describe('FeatureService', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-feature-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const createService = (features: Partial<FeatureManifest> = {}): FeatureService => {
    const fullFeatures: FeatureManifest = {
      streaming: true,
      notifications: true,
      objectDetection: false,
      remoteAccess: true,
      agentCluster: false,
      smartHome: true,
      recordings: true,
      backup: true,
      repl: true,
      ...features,
    }

    const configPath = path.join(tmpDir, 'config.yaml')
    fs.writeFileSync(
      configPath,
      yaml.dump({
        server: { port: 4443 },
        auth: { adminPassword: 'secret123' },
      }),
      'utf-8',
    )
    const configService = new StaticFeatureConfigService(configPath, fullFeatures)
    return new FeatureService(configService)
  }

  it('returns true for enabled features', () => {
    const service = createService({ streaming: true, notifications: true })

    expect(service.isEnabled('streaming')).toBe(true)
    expect(service.isEnabled('notifications')).toBe(true)
    expect(service.isEnabled('remoteAccess')).toBe(true)
  })

  it('returns false for disabled features', () => {
    const service = createService({ objectDetection: false, agentCluster: false })

    expect(service.isEnabled('objectDetection')).toBe(false)
    expect(service.isEnabled('agentCluster')).toBe(false)
  })

  it('returns full manifest', () => {
    const customFeatures: Partial<FeatureManifest> = {
      streaming: false,
      objectDetection: true,
    }
    const service = createService(customFeatures)

    const manifest = service.getManifest()

    expect(manifest.streaming).toBe(false)

    expect(manifest.objectDetection).toBe(true)

    expect(manifest.notifications).toBe(true)

    expect(manifest.remoteAccess).toBe(true)
  })
})
