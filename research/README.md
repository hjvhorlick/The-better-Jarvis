# Internet Research — Stage 2

The Research room is a bounded, read-only public-web research workspace. It is integrated with the existing dashboard and its existing Gemini configuration; it does not add a separate search credential, paid package, or email provider.

## Provider, configuration, usage, and costs

- Provider: Google Search grounding through the existing Gemini API key. The server checks `GEMINI_API_KEY` / the existing `config/api_keys.json` setting and reports when neither is configured. The key is never sent to the browser or included in research prompts.
- The configured text-model resolver is reused. Search grounding needs a Gemini model/account that currently supports the Google Search tool. A successful model reply without grounding source metadata is not treated as a web search; the workflow tries the next configured candidate when available, then reports failure.
- A task has a bounded grounded-search stage and a source-led report stage. Each stage can try at most two configured models, so an attempt may use shared Gemini budget and incur model-token charges. Google Search grounding can add usage-based search charges and the provider can create several search queries. The app's daily budget counts Gemini calls, not provider-internal search queries. Follow-up questions use the same Gemini configuration and shared budget but do not enable Search; refreshing a report starts a fresh web search.
- At most two research tasks are active at once. Existing shared app/Gemini quotas and provider rate limits still apply; no rate-limit or quota override is added.
- Google's [Search grounding documentation](https://ai.google.dev/gemini-api/docs/google-search), retrieved 23 September 2026, reported 5,000 free Google Search grounding requests per month shared across Gemini 3+ models, then USD $14 per 1,000 requests; Gemini token charges are separate. Gemini 2.5 and older were billed per prompt. These terms, free allowances, supported models and account billing can change. Review Google's current documentation and the billing/quotas for your own account before using Research.
- No live Google/Gemini request was made as part of the Stage 2 automated tests. Tests inject mock search, page-fetch and synthesis services.

## Workflow and evidence handling

1. Accept an explicit typed or final voice research command, or a question entered in Research. Ordinary chat is not routed to web search. An incomplete command prefix asks for clarification without searching.
2. Send the user's question to Google Search grounding. Search query strings and citation metadata returned by Google are retained, bounded and shown in the report.
3. Validate returned links as HTTP(S), resolve every address, and omit private or non-public destinations. Open no more than three pages per task.
4. Fetch each page with a pinned public address and revalidate every redirect destination. The fetcher allows at most three redirects, uses only standard HTTP/HTTPS ports, times out after eight seconds, accepts HTML/XHTML/plain text only, and caps a response at one megabyte. It does not send cookies, credentials, or form data; it does not log in or submit forms.
5. Extract at most 1,800 readable characters per page for the report. A successful fetch is explicitly described as a bounded text extract, not a full-page review. Google-grounding check timestamps are distinct from page-fetch attempt timestamps; a page not opened has no page-access date. Search-only citations, blocked links, unavailable/insufficient pages and publication dates that are not stated remain labelled as such.
6. Synthesize only the supplied search evidence and source extracts. Inline source IDs are checked; unsupported citation markers are removed. Extract-supported facts, search-only/publisher claims, inferences, open questions, uncertainty, gaps and recommendations are explicitly distinguished. No report is created from model knowledge alone if grounding metadata or traceable sources are missing.

Web titles, excerpts, URLs, search summaries and saved report text are untrusted data. They are passed to the model as explicitly untrusted JSON, never as instructions. Research calls do not include the assistant's private-memory prompt, local files, or credentials. Research content is rendered as text in the UI; source links are separately checked before they can be opened in a new tab. Downloaded content is never executed.

## Local data and user actions

- Saved reports are individual JSON files under `runtime/research/` with stable UUIDs and report/source metadata. This directory is covered by the existing `runtime/` ignore rule. Files are written locally with restrictive permissions; malformed or symlinked records are skipped rather than treated as valid reports.
- Search tasks and their progress are held in server memory and disappear on restart. Save a completed report explicitly to keep it. Renaming and deleting require actions in Research; deletion asks for confirmation.
- Refreshing an existing report leaves the old saved report intact until a complete replacement is available. A successful refresh keeps its report ID and owner-chosen title.
- Follow-ups use the saved report and its bounded extracts only; they do not trigger web search. The answer is labelled with that limitation.
- Nothing is automatically copied into long-term memory. The optional “Save a concise finding to local knowledge” form writes only the question and answer the user enters, after explicit submission.
- “Create Email draft” is an explicit local draft action. It does not send email. Stage 1's no-email-provider/no-send boundary remains unchanged; there are no social publishing, Scenering, or later-stage actions here.
- Copy and Markdown export operate on the report text locally.

## API surface

All Research API routes require the dashboard's existing session authentication:

- `GET /api/research/status`
- `GET|POST /api/research/tasks`, `GET /api/research/tasks/:id`
- `GET|POST /api/research/reports`, `GET|PATCH|DELETE /api/research/reports/:id`
- `POST /api/research/reports/:id/update`
- `POST /api/research/reports/:id/followup`
- `POST /api/research/reports/:id/memory` (explicit local knowledge save)

The UI lives in `web/environments/research.js` and `research.css`, is lazily loaded through the existing room registry, and can be opened by the dashboard's room switcher or an explicit typed/voice room command.

## Checks

Run the mocked research tests and static type check with:

```sh
node --import tsx --test tests/research.test.mjs
npm run lint
```

The broader JavaScript regression set is:

```sh
node --import tsx --test tests/*.test.mjs
```

Manual provider smoke testing is optional and not performed automatically: configure the existing Gemini key/model, open Research, confirm the displayed provider/model and current billing terms, then submit a low-risk public question. Check task progress, returned queries, each source's access status/extract/access date, citations, saved-report reopen/rename/delete, follow-up (no new search), copy/export, local email draft (not sent), and the deliberately optional memory form. Remove the temporary test report if desired.
