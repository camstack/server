import * as path from 'node:path'

/** Single source of truth for the lifecycle job journal directory. */
export function lifecycleJobsDir(dataDir: string): string {
  return path.join(dataDir, 'lifecycle', 'jobs')
}
