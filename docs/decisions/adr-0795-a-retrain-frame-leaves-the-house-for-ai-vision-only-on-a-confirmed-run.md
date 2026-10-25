---
id: D795
title: A retrain frame is sent to an AI-vision profile outside the house only on a run the operator confirmed, and the provider enforces it
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/retrain-llm-assist.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/retrain-llm-service.ts
  - packages/types/src/capabilities/pipeline-analytics.cap.ts
  - packages/addon-training/src/page/frames/RetrainAssistPanel.tsx
---

## Context

The Retrain page gained an AI-vision pre-annotation engine over the existing
`llm` capability: the frame copy, the target classes and the boxes on the
canvas go to a vision-capable profile, which lists objects and reviews the
boxes. Profiles can be local (a managed llama.cpp runtime, Apple Foundation
Models, an OpenAI-compatible server on the LAN) or a cloud vendor. The cloud
training plan's privacy answer for training frames is "never leave the house
for the MVP" (Q3); the operator asked that a cloud profile be usable for this
assist, with the frame leaving only on a confirmation per batch.

A confirmation that lives only in the page is one bug away from shipping a
camera frame to a vendor: any other caller of the cap method, or a page that
forgets the dialog, would send it silently.

## Decision

**`proposeRetrainAnnotationsWithLlm` refuses (`cloud-not-confirmed`) a profile
that sends the frame outside the house unless the call carries
`allowCloud: true`; the page sets it only on a run the operator confirmed in a
dialog that names the destination, and asks again on every run. Whether a
profile leaves the house is ONE rule, `llmProfileLeavesHouse`, answered by the
server (`listRetrainAssistProfiles[].leavesHouse`).**

- Cloud kinds (`openai`, `anthropic`, `google`) always leave; `managed-local`
  and `apple-foundation` never do.
- An `openai-compatible` endpoint leaves unless its host is loopback, a
  private / CGNAT / link-local address, a `.local` / `.lan` name or a bare
  host name. No URL, or one that does not parse, counts as leaving.
- A run is one frame. Nothing logged carries the image, the prompt or the
  answer — profile, counts and outcome only.

## Consequences

- No batch "send N frames" exists; a batch would need its own confirmation
  naming the count, under this rule.
- A self-hosted endpoint on a public address counts as cloud (it is outside
  the house); the operator sees "cloud" and is asked.
- The model's answer is untrusted input: parsed against a strict schema,
  malformed answers refused, bad items dropped and counted, everything a
  draft (D790).

## Enforcement

`retrain-llm-service.spec.ts` (refused without `allowCloud`, sent with it,
no request made on refusal), `retrain-llm-assist.spec.ts` (the locality rule,
the strict parse) and `retrain-assist-panel.spec.tsx` (the dialog before a
cloud run, `allowCloud` only after it).
