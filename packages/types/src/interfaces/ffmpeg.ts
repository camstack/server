export interface FfmpegConfig {
  readonly path: string
  readonly hwaccel?: 'vaapi' | 'qsv' | 'videotoolbox' | 'cuda' | 'v4l2m2m' | 'none'
  readonly inputArgs?: readonly string[]
  readonly outputArgs?: readonly string[]
  readonly videoCodec?: string
  readonly audioCodec?: string
  readonly threads?: number
}
