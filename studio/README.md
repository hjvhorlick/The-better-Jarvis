# Studio video projects

Studio is a preparation workspace for editable video briefs and scene scripts. Scenering remains a separate application; this integration does not import, upload, publish, or send a project there.

## Local data and routes

- Saved projects are individual JSON records under `runtime/media/projects/<uuid>.json`. Project UUIDs are stable; duplicate creates a new UUID. Project files are separate from `runtime/knowledge.json` and personal memory.
- An explicitly selected Stage 2 Research report is read from `runtime/research/<uuid>.json`. The project retains its report text and source links. Studio does not start a new web search when writing a script.
- The authenticated primary Node dashboard exposes `/api/studio/projects`, `/api/studio/research-reports`, `/api/studio/scripts`, and the project text-copy endpoint. The script writer uses the existing Gemini configuration and shared daily call budget. A provider call is not made until the user asks Studio to write or break a script.
- The project format is restricted to 16:9 or 9:16, with a requested duration of 5–600 seconds. Stored scripts use the existing title and ordered-scene shape, with narration, on-screen text, visual prompt, timing, and optional source IDs.

## Scenering handoff

The public Scenering README describes its editor workflow but does not document a supported project-import API or file format. Studio therefore opens `https://scenering.com` separately and offers plain-text copy for a script, scene breakdown, or project brief. The user must paste/import manually in Scenering. Copy and opening a tab are not represented as a transfer. No authenticated scraping, automatic login, undocumented endpoint, upload, or publish action is used.

## Trust and provenance

Saved report/source text and pasted scripts are treated as untrusted input data and are never executed. Generated factual claims must be reviewed against the attached report and links; unknown citation IDs are removed. Music, sound, visual prompts, and other creative treatments are labelled separately from source-based notes. A report is never turned into a video automatically, and a video project is never automatically saved to personal memory.

## Checks

Run the focused checks from the repository root:

```sh
npm run lint
node --import tsx --test tests/studio-projects.test.mjs
node tools/check_studio_room.mjs
```
