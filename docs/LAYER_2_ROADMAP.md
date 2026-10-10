# Layer 2 — progress against the current Supper AI Agent code

This is a working status document for the Layer 2 capability list. It is based on the
repository snapshot reviewed on 2026-10-10. “Present in code” does not mean a feature
has been verified with the owner's real camera, microphone, accounts or external services.

## Current status

| Capability | Current state |
|---|---|
| Email | This branch adds a local draft room: compose, save drafts in this browser, load/delete, copy, and open a draft in the user's configured mail app. It does not connect to an email provider or send messages. |
| Scenering | A separate application at https://scenering.com. Studio already prepares/copies the script and opens the site in a separate tab. Do not recreate Scenering or assume a private API exists. |
| Book publishing | No complete manuscript-to-publishing workflow has been verified in the reviewed files. |
| Internet research | The agent has a web-search intent and a knowledge store. A source-aware research project workflow with saved URLs, timestamps and summaries remains a separate improvement. |
| Social media | Studio prepares video metadata. Authenticated posting is not established. |
| Video creation | Studio includes script creation, image generation, editable shots, a media library and browser canvas recording. Real service and browser operation still need owner testing. |
| Marketing | Some reusable video metadata exists; an end-to-end campaign workflow remains to be built. |
| File management | A restricted local file browser and text previews are present. Keep allowed-root checks. |
| Applications/computer control | Keep controls permission-gated. Do not add unrestricted shell execution. |
| Voice and My Hands | The architecture, device owners and gesture paths exist in code. Real camera, microphone, speaker and whole-hand behavior need practical verification. |

## Implementation order

1. Preserve the Scenering boundary: it is a separate application accessed at its website. Keep the current copy/open workflow; do not treat it as a built-in video engine or direct API integration.
2. Add safe email drafting first. This branch implements local drafts and hands them to the user's configured mail app for review. Provider OAuth/API sending is a later stage requiring a provider choice, secure server-side credentials and explicit confirmation for each send.
3. Add a source-aware research workspace: query, source URL, title, access timestamp, short notes, and saved research projects. Clearly separate source facts from model-generated synthesis.
4. Build social publishing one provider at a time with preview and confirmation before publication.
5. Build a local manuscript workspace (chapters, metadata, export and validation) before choosing a book-publishing provider.
6. Connect approved content to a marketing planner and platform-specific drafts. Sending or publishing must remain a separate confirmed action.
7. Continue My Hands and voice improvements with repeatable diagnostics and real-device test steps.

## Safety requirements

- Preserve the existing personality and personal memory; do not reset or migrate them as part of these upgrades.
- Keep provider credentials on the server and out of browser code and Git.
- Drafting and preview are separate from sending, posting, deleting, or changing external accounts.
- Keep integrations optional when credentials are absent; the agent must still start.
- Do not run self-modification automatically. Owner approval, testing on a copy and rollback remain required.
- Automated tests do not prove that live hardware or external services work; record those checks separately.

## This branch

The `layer-2-email-drafts` branch adds a lazily loaded Email environment. Drafts are stored in
this browser's localStorage, with no server upload. “Open in mail app” uses a `mailto:` link
and does not send the message itself. Focused tests have been added but not executed by the
GitHub connector; run them and the full suite in the project environment before merging.
