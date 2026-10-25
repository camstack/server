export interface FeatureManifest {
  streaming: boolean
  notifications: boolean
  objectDetection: boolean
  remoteAccess: boolean
  agentCluster: boolean
  smartHome: boolean
  recordings: boolean
  backup: boolean
  repl: boolean
}

export type FeatureFlag = keyof FeatureManifest

export const DEFAULT_FEATURES: FeatureManifest = {
  streaming: true,
  notifications: true,
  objectDetection: false,
  remoteAccess: true,
  agentCluster: false,
  smartHome: true,
  recordings: true,
  backup: true,
  repl: true,
}
