export interface ZoneDefinition {
  readonly id: string
  readonly name: string
  readonly cameraId: string
  readonly type: 'polygon' | 'tripwire'
  readonly points: ReadonlyArray<{ readonly x: number; readonly y: number }>
  readonly direction?: 'in' | 'out' | 'both'
  readonly alertOnClasses?: readonly string[]
  readonly color?: string
}

export interface KnownFace {
  readonly id: string
  readonly name: string
  readonly label?: string
  readonly embeddings: readonly Float32Array[]
  readonly thumbnailPath?: string
  readonly createdAt: number
}

export interface KnownPlate {
  readonly id: string
  readonly plateText: string
  readonly label?: string
  readonly vehicleDescription?: string
  readonly createdAt: number
}

export interface KnownAudioEvent {
  readonly id: string
  readonly className: string
  readonly label: string
  readonly notifyAlways: boolean
}
