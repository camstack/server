import type { FeatureManifest, FeatureFlag } from '@camstack/types'

export type { FeatureManifest, FeatureFlag }

export type FeatureConfigReader = {
  readonly features: FeatureManifest
}

export class FeatureManager {
  constructor(private readonly configReader: FeatureConfigReader) {}

  isEnabled(flag: FeatureFlag): boolean {
    return this.configReader.features[flag]
  }

  getManifest(): FeatureManifest {
    return { ...this.configReader.features }
  }
}
