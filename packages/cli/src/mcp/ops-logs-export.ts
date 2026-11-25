/**
 * `ops_logs_export` (#570): the Logs page export from the public MCP. It reuses
 * the hub's `GET /api/logs/export` route and the same defaults (everything,
 * the last six hours) through `@camstack/develop`, writes one NDJSON file (or, with `zip`, one .zip holding it) under
 * `~/.camstack/exports/logs/` (0600) and answers with a bounded summary.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  createHubDownloader,
  defaultSessionDir,
  downloadLogsExport,
  type LogsExportArgs,
  type LogsExportDownload,
} from '@camstack/develop'
import type { McpContext } from './context.js'
import { reasonOf, withHub, type NoSessionResult, type RefusedResult } from './ops-hub.js'

export interface OpsLogsExportResult extends LogsExportDownload {
  readonly status: 'ok'
  readonly path: string
  readonly next: string
}

export async function opsLogsExport(
  ctx: McpContext,
  args: LogsExportArgs,
  now: () => Date = () => new Date(),
): Promise<OpsLogsExportResult | NoSessionResult | RefusedResult> {
  return withHub(ctx, async (connection): Promise<OpsLogsExportResult | RefusedResult> => {
    if (connection.tier !== 'admin') {
      return {
        status: 'refused',
        reason: `the logs export is admin-only and this credential is not admin-scoped.${connection.adminHint ? ` ${connection.adminHint}` : ''}`,
      }
    }
    const at = now()
    const stem = args.name ?? `logs-${at.toISOString().replace(/[:.]/g, '-')}`
    const dir = path.join(ctx.exportDir ?? path.join(defaultSessionDir(), 'exports'), 'logs')
    const dest = path.join(dir, `${stem}.${args.zip === true ? 'zip' : 'ndjson'}`)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const download =
      ctx.downloader?.(connection) ??
      createHubDownloader({
        baseUrl: connection.server,
        token: connection.token,
        tls: connection.tls,
      })
    try {
      const done = await downloadLogsExport(download, dest, args, at)
      return {
        status: 'ok',
        path: dest,
        ...done,
        next:
          args.zip === true
            ? 'A .zip holding one NDJSON file (one JSON object per line, newest first): unzip -p <path> | grep/jq; tags.deviceId names the camera.'
            : 'One JSON object per line (newest first): grep/jq the file; tags.deviceId names the camera.',
      }
    } catch (err) {
      return { status: 'refused', reason: `logs export failed: ${reasonOf(err)}` }
    }
  })
}
