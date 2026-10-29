/**
 * "Am I still a member?" (D857): the hub answers `revoked` only to the holder of a leaf's private
 * key, and the agent believes only an answer the pinned mesh CA signed for ITS nonce and leaf.
 */
import { X509Certificate } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { generateMeshCa, issueMeshLeafForNode } from '../mesh-ca.js'
import { MeshCertificateRegistry } from '../mesh-certificate-registry.js'
import { MeshCrl } from '../mesh-crl.js'
import {
  MembershipResponder,
  signMembershipProof,
  verifyMembershipAnswer,
} from '../mesh-membership.js'
import { memoryStore } from './memory-settings-store.js'

async function setup() {
  const ca = await generateMeshCa()
  const registry = new MeshCertificateRegistry(memoryStore())
  const crl = new MeshCrl()
  const leaf = await issueMeshLeafForNode(ca, 'agent-old')
  await registry.recordIssued('agent-old', leaf.certPem, 'pairing')
  const responder = new MembershipResponder({
    registry: () => registry,
    crl: () => crl,
    caKeyPem: () => ca.keyPem,
  })
  const fingerprint = new X509Certificate(leaf.certPem).fingerprint256
  const ask = (nonce: string, signed = leaf.keyPem, certPem = leaf.certPem) =>
    responder.answer({
      nodeId: 'agent-old',
      certPem,
      nonce,
      signature: signMembershipProof(signed, 'agent-old', nonce),
    })
  return { ca, registry, crl, leaf, responder, fingerprint, ask }
}

function answerOf(
  outcome: ReturnType<MembershipResponder['answer']>,
  caCertPem: string,
  nonce: string,
  fingerprint: string,
) {
  if (!outcome.ok) throw new Error(`refused ${outcome.status}`)
  return verifyMembershipAnswer(caCertPem, outcome.token, {
    nodeId: 'agent-old',
    nonce,
    leafFingerprint: fingerprint,
  })
}

describe('membership - the hub side', () => {
  it('answers `member` to the holder of a live leaf the hub issued', async () => {
    const t = await setup()
    const nonce = t.responder.issueChallenge()
    expect(answerOf(t.ask(nonce), t.ca.certPem, nonce, t.fingerprint)).toEqual({
      status: 'member',
    })
  })

  it('answers `revoked` with the reason once the node was forgotten', async () => {
    const t = await setup()
    await t.registry.revokeAllForNode('agent-old', 'forgotten', t.crl)
    const nonce = t.responder.issueChallenge()
    expect(answerOf(t.ask(nonce), t.ca.certPem, nonce, t.fingerprint)).toEqual({
      status: 'revoked',
      reason: 'forgotten',
    })
  })

  it('answers `unknown` to a valid proof over a leaf the hub never issued', async () => {
    const t = await setup()
    const otherCa = await generateMeshCa()
    const stranger = await issueMeshLeafForNode(otherCa, 'agent-old')
    const nonce = t.responder.issueChallenge()
    const outcome = t.ask(nonce, stranger.keyPem, stranger.certPem)
    expect(
      answerOf(outcome, t.ca.certPem, nonce, new X509Certificate(stranger.certPem).fingerprint256),
    ).toEqual({ status: 'unknown' })
  })

  it('REFUSES (401, no token) a caller that presents the certificate but signs with another key', async () => {
    const t = await setup()
    await t.registry.revokeAllForNode('agent-old', 'forgotten', t.crl)
    const impostor = await issueMeshLeafForNode(t.ca, 'agent-old')
    const nonce = t.responder.issueChallenge()
    // The leaf is public (it crosses every handshake); its private key is what proves membership.
    expect(t.ask(nonce, impostor.keyPem)).toEqual({ ok: false, status: 401 })
  })

  it('spends a nonce on first use and refuses one it never issued', async () => {
    const t = await setup()
    const nonce = t.responder.issueChallenge()
    expect(t.ask(nonce).ok).toBe(true)
    expect(t.ask(nonce)).toEqual({ ok: false, status: 401 })
    expect(t.ask('never-issued')).toEqual({ ok: false, status: 401 })
  })

  it('refuses a malformed body and says not-ready (503) while the registry is not loaded', async () => {
    const t = await setup()
    expect(t.responder.answer({ nodeId: 'agent-old' })).toEqual({
      ok: false,
      status: 400,
    })
    const notReady = new MembershipResponder({
      registry: () => null,
      crl: () => t.crl,
      caKeyPem: () => t.ca.keyPem,
    })
    const nonce = notReady.issueChallenge()
    expect(
      notReady.answer({
        nodeId: 'agent-old',
        certPem: t.leaf.certPem,
        nonce,
        signature: signMembershipProof(t.leaf.keyPem, 'agent-old', nonce),
      }),
    ).toEqual({ ok: false, status: 503 })
  })
})

describe('membership - the agent verifies the answer', () => {
  it('believes nothing a different CA signed (a forged "revoked")', async () => {
    const t = await setup()
    const forger = await setup()
    await forger.registry.revokeAllForNode('agent-old', 'forgotten', forger.crl)
    const nonce = forger.responder.issueChallenge()
    const outcome = forger.ask(nonce)
    // Verified against the CA THIS agent pinned.
    expect(answerOf(outcome, t.ca.certPem, nonce, forger.fingerprint)).toBeNull()
  })

  it('refuses an answer bound to another nonce (a replay) or another leaf', async () => {
    const t = await setup()
    await t.registry.revokeAllForNode('agent-old', 'forgotten', t.crl)
    const nonce = t.responder.issueChallenge()
    const outcome = t.ask(nonce)
    expect(answerOf(outcome, t.ca.certPem, 'a-newer-nonce', t.fingerprint)).toBeNull()
    expect(answerOf(outcome, t.ca.certPem, nonce, 'AA:BB')).toBeNull()
  })

  it('refuses an expired answer', async () => {
    const t = await setup()
    const nonce = t.responder.issueChallenge()
    const outcome = t.ask(nonce)
    if (!outcome.ok) throw new Error('refused')
    expect(
      verifyMembershipAnswer(t.ca.certPem, outcome.token, {
        nodeId: 'agent-old',
        nonce,
        leafFingerprint: t.fingerprint,
        nowMs: Date.now() + 5 * 60_000,
      }),
    ).toBeNull()
  })
})
