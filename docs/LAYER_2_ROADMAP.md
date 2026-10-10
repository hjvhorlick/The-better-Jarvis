# Layer 2 — capability expansion roadmap

Status: started against the latest `main` snapshot reviewed on 2026-10-10.
Working branch: `layer-2-scenering-handoff`.

This document tracks the original Layer 2 goals against what is present in the current
repository. “Present in code” is not the same as “verified on the owner's computer”.

## Current position

| Capability | Current evidence | Status |
|---|---|---|
| Browser-based Supper AI Agent | FastAPI backend and `web/` workbench | Present in code; local runtime still needs owner verification |
| Conversation and Gemini connection | `backend/chat.py`, `backend/agent.py`, server-side key handling and daily budget | Present in code; live provider call not verified here |
| Voice | `backend/voice/` controller, audio owners, Live relay and UI controls | Implemented with automated tests; real microphone/speaker round-trip still needs testing |
| My Hands | `myhands/`, whole-hand landmarks and gesture state machines | Implemented in code; real-camera tracking and gesture tuning still need testing |
| Internet research | Web-search path and budget-aware Gemini request | Partly present; broader research workflow, source notes and saved research projects are not yet established |
| Video creation | Studio script generation, picture generation, editable shots, canvas playback/recording and media library | Present in code; live image service and real browser recording need owner verification |
| Scenering | Existing paste-ready handoff via `scenering_payload`; no direct API upload is evidenced | Partial; this branch enriches the handoff with structured shot and publishing metadata |
| Email | No provider connection or email-send workflow was found in the reviewed current files | Not implemented |
| Book publishing | No end-to-end manuscript, formatting, metadata or publishing workflow was found | Not implemented |
| Social publishing | Studio creates title/description/hashtags, but no authenticated posting workflow was found | Partial content preparation only; posting is not implemented |
| Marketing | Some video metadata is generated; no campaign planner or cross-channel workflow was found | Partial building blocks only |
| File management | Local allowed-root browsing and previews | Present with path restrictions; expand only through explicit permission tiers |
| Application/computer control | Not available as unrestricted browser shell access; `shell.run` remains blocked | Must remain confirmation-gated and narrowly scoped |

## Safe implementation order

1. **Improve the existing Scenering handoff first.** Keep all current response fields compatible, and add structured title variants, hook, logline, description, hashtags and per-shot details. Do not send data to Scenering automatically.
2. **Establish provider-neutral integration boundaries and permission rules.** Read-only access and drafting can be separate from sending, publishing, deleting or changing external accounts.
3. **Email:** start with composing and previewing a draft. Do not send messages until the owner has selected a provider, connected credentials securely, and explicitly approved the individual send action.
4. **Research:** save queries, source URLs, short summaries and timestamps so results can be revisited and checked.
5. **Social publishing:** build one provider at a time, using the provider's supported API and a preview/confirmation step before any post is published.
6. **Book publishing:** first build a local manuscript/project workflow (chapters, metadata, export and validation); connect a publishing platform only after the target platform and its API/requirements are known.
7. **Marketing:** reuse the approved content package to prepare platform-specific copy and schedules; actual sending or posting must remain a separate confirmed action.

## Guardrails

- Preserve the existing personality and memory. Never reset, rewrite or migrate personal memory as part of Layer 2.
- Keep API keys and OAuth tokens on the server, never in browser JavaScript or committed files.
- Unknown actions remain denied by default. Sending email, publishing posts, deleting files and changing account settings require explicit confirmation.
- No unrestricted shell execution or autonomous self-modification.
- Keep new integrations optional when credentials are absent; ordinary chat, My Hands and the Studio must still start.
- Each feature needs focused automated tests. A test passing in CI does not prove that a real camera, microphone, external API or publishing account works.

## First change in progress

The branch `layer-2-scenering-handoff` extends `scenering_payload` with structured fields while
preserving the existing `title`, `script`, `plain`, `shots`, `seconds` and `url` fields.
Unit and API tests are updated. The GitHub connector cannot execute the test suite, so these
tests still need to be run in the project environment before merging.
