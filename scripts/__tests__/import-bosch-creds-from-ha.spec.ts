import { describe, expect, it } from 'vitest'
// @ts-expect-error -- operator .mjs without declarations
import * as script from '../ops/import-bosch-creds-from-ha.mjs'

describe('import-bosch-creds-from-ha (operator one-off)', () => {
  const fixture = {
    data: {
      entries: [
        {
          entry_id: 'shc-1',
          domain: 'bosch_shc',
          title: 'SHC Casa',
          data: {
            host: '192.0.2.20',
            ssl_certificate: '/config/bosch_shc/64-da-a0-43-9a-dd/bosch_shc-cert.pem',
            ssl_key: '/config/bosch_shc/64-da-a0-43-9a-dd/bosch_shc-key.pem',
            token: 'never-log-this',
          },
        },
        {
          entry_id: 'hc-1',
          domain: 'homeconnect_ws',
          title: 'Home Connect',
          data: {
            refresh_token: 'rt-secret',
            access_token: 'at-secret',
          },
        },
        {
          entry_id: 'ignore',
          domain: 'mqtt',
          data: { password: 'x' },
        },
      ],
    },
  }

  it('filters only Bosch HA domains', () => {
    const all = script.entriesFromHaStorage(fixture)
    const bosch = script.filterBoschEntries(all)
    expect(bosch.map((e: { domain: string }) => e.domain)).toEqual(['bosch_shc', 'homeconnect_ws'])
  })

  it('redacts summaries without secret values', () => {
    const entry = script.filterBoschEntries(script.entriesFromHaStorage(fixture))[0]
    const summary = script.redactEntrySummary(entry)
    expect(summary.host).toBe('192.0.2.20')
    expect(summary.secretPresence.token).toBe(true)
    expect(JSON.stringify(summary)).not.toContain('never-log-this')
  })

  it('builds camstack-import without inline secrets (PEM paths only in settings)', () => {
    const entries = script.filterBoschEntries(script.entriesFromHaStorage(fixture))
    const outDir = '/tmp/scratchpad/bosch-ha-import'
    const pemFiles = [
      {
        haPath: '/config/bosch_shc/64-da-a0-43-9a-dd/bosch_shc-cert.pem',
        localPath: `${outDir}/pem/shc-1_bosch_shc-cert.pem`,
      },
      {
        haPath: '/config/bosch_shc/64-da-a0-43-9a-dd/bosch_shc-key.pem',
        localPath: `${outDir}/pem/shc-1_bosch_shc-key.pem`,
      },
    ]
    const plan = script.buildCamstackImport(entries, { outDir, pemFiles })
    const blob = JSON.stringify(plan)
    expect(blob).not.toContain('never-log-this')
    expect(blob).not.toContain('rt-secret')
    expect(plan.readyToApply).toBe(false)
    const shc = plan.integrations.find((i: { haDomain: string }) => i.haDomain === 'bosch_shc')
    expect(shc.settings.sslCertificatePath).toContain('shc-1_bosch_shc-cert.pem')
    expect(shc.secretsSource.fields.token).toBe('data.token')
  })

  it('parseVirshAgentJson ignores virsh welcome banner', () => {
    const payload = { return: { pid: 42 } }
    const raw = `Welcome to virsh, the virtualization interactive terminal.\n\n${JSON.stringify(payload)}`
    expect(script.parseVirshAgentJson(raw)).toEqual(payload)
  })

  it('collectPemHaPaths prefixes entry id for local PEM names', () => {
    const entries = script.filterBoschEntries(script.entriesFromHaStorage(fixture))
    const pem = script.collectPemHaPaths(entries)
    expect(
      pem.map((p: { localPath?: string; entryId: string; haPath: string }) => p.entryId),
    ).toEqual(['shc-1', 'shc-1'])
    expect(pem[0].haPath).toContain('bosch_shc-cert.pem')
  })
})
