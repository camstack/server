/**
 * The cluster update job, durable across the hub restart the job itself
 * causes. One small JSON file under the hub's data dir, written atomically
 * (tmp + rename), the same mechanism the neighbouring update state uses — not
 * the settings database, which the hub's own update restarts too.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  ClusterUpdateJobSchema,
  errMsg,
  type ClusterUpdateJob,
  type IScopedLogger,
} from '@camstack/types'
import type { ClusterUpdateJobStore } from './cluster-update-seams.js'

export const CLUSTER_UPDATE_JOB_FILE = path.join('cluster-update', 'job.json')

export class FileClusterUpdateJobStore implements ClusterUpdateJobStore {
  readonly filePath: string

  constructor(
    dataDir: string,
    private readonly logger: IScopedLogger,
  ) {
    this.filePath = path.join(dataDir, CLUSTER_UPDATE_JOB_FILE)
  }

  load(): ClusterUpdateJob | null {
    try {
      if (!fs.existsSync(this.filePath)) return null
      const raw: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'))
      const parsed = ClusterUpdateJobSchema.safeParse(raw)
      if (parsed.success) return parsed.data
      this.logger.warn('Cluster update job file does not parse; ignoring it', {
        meta: { path: this.filePath, error: parsed.error.message },
      })
      return null
    } catch (error: unknown) {
      this.logger.warn('Cluster update job file unreadable; ignoring it', {
        meta: { path: this.filePath, error: errMsg(error) },
      })
      return null
    }
  }

  save(job: ClusterUpdateJob): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(job, null, 2))
      fs.renameSync(tmp, this.filePath)
    } catch (error: unknown) {
      // The job goes on; what is lost is its resume across the hub restart,
      // which the resumed boot then reports as `interrupted`.
      this.logger.error('Failed to persist the cluster update job', {
        meta: { path: this.filePath, jobId: job.id, error: errMsg(error) },
      })
    }
  }
}
