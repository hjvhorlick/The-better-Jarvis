# Local knowledge: answers kept on this computer

Status: built and tested (`tests/test_knowledge.py`). The starter answers were written by the
assistant and have not been checked by a specialist. Please check any answer before you rely on it.

## What it is

A small store of answers on this computer, in `runtime/knowledge.json`. A question is answered from
it first, with no Gemini call and no budget unit. Only a question it cannot answer goes to Gemini,
and Gemini's answer is then kept for next time.

There are three kinds of entry:

| Kind | Where it comes from | Expires? |
|---|---|---|
| starter | written by the assistant for common tasks in coding, marketing and design, and everyday sums and conversions (`knowledge/starter.json`). Marked "please check" in the reply | no |
| owner | you teach it: `learn: <question> = <answer>` | no |
| gemini | a Gemini answer, kept so the same question is not paid for twice. Shown as "saved from an earlier Gemini answer, <date>". Every one records **which model made it** | yes, after 30 days (`SUPPER_KNOWLEDGE_DAYS`) |

## A kept Gemini answer from a different model is not used silently

Every Gemini answer is kept with the model that produced it (`provenance`: the model's
name, the time, and the schema version). That record decides what happens next:

- an answer that records **the model in use now** answers directly, as before — no Gemini
  call, no budget unit;
- an answer with **no record** (written before the app kept provenance) or from a
  **different model** is *stale*: the model is asked first. The stored words are used only
  when the model cannot be reached (no key, spent budget, a failed call), and then they
  are labelled plainly: made by which model, on what date, and "not re-checked with
  <current model> — the AI could not be reached just now, so please check anything that
  may have changed since".
- When the current model does answer, it **replaces** the stale entry; the old words are
  moved to the archive with the reason ("superseded by <model>"). Nothing is deleted, and
  an answer you taught is never replaced by a model's answer.

## What is never kept

- Anything time-sensitive: words such as today, now, latest, news, price, weather, score, or a year
  such as 2026. The answer would be out of date.
- Questions about you ("my ..."). Those belong to you, not to everyone who asks.
- Very long questions or answers, and answers that say they may be out of date.

## Commands

- `learn: <question> = <answer>` (or `learn that <question> means <answer>`): teach an answer.
- `what have you learned`: how many entries there are, and the first ten with their numbers.
- `forget <number>`: moves an entry to the archive. Nothing is deleted.

To stop new Gemini answers being kept, set `SUPPER_KNOWLEDGE_LEARN=off`. Existing entries still work.

## How a question is matched

The meaningful words of the question must mostly appear in a stored question. Filler words such as
"how", "do" and "please" are ignored. A match needs at least about three quarters of the words to
agree. This is strict on purpose: if in doubt, the question goes to Gemini, which costs one unit,
rather than giving a wrong stored answer.

## Where things are kept

- `runtime/knowledge.json`: all entries and the archive. It is git-ignored. Deleting the `runtime`
  folder deletes the learned answers. It does not touch your memory (`memory/long_term.json`).
- The file's `version` is 2 (provenance-aware), but a version 1 file — everything written
  before the model was recorded — is read whole and each Gemini entry in it is simply
  treated as stale, not as current. Nothing is rewritten or lost on the first read.
- The first time an older file is written in the new shape, a **hash-verified copy** is
  taken first (`runtime/backups/knowledge.v1-<time>-<id>.json`, with a manifest recording
  the sha256 and the reason). It is the same rule the Persistent Brain follows before it
  rewrites a store. The upgrade only adds a field, so entries and archive rows are carried
  over exactly as they were; the copy is there so that "nothing was lost" can be checked.
- A damaged file is kept aside as `knowledge.json.bad-<time>`, and the store starts again. Nothing is lost.
- Expired and forgotten entries go to the archive list in the same file.

## The dashboard (the glass build) uses the same store

The main build (`server.ts` + `dashboard/static/app.html`) reads and writes
`runtime/knowledge.json` in the engine room's own format, with the same matching
rules (meaningful words, plural stemming, three-quarters overlap), the same
wording ("[starter answer written by the assistant: please check]",
"(saved from an earlier Gemini answer, <date>)") and the same safety rules for
keeping an answer. It is one base, not two:

- an answer taught in the desktop app answers a question typed into the
  dashboard, and the other way round (`tests/config_harness.mjs` proves both
  directions by having the Python module and the dashboard read each other's work);
- each half re-reads the file when it changes on disk, so neither has to be
  restarted for the other's entries to appear;
- writes are atomic and merged by entry, so both can use the store at once.

The dashboard's commands are the same ones:

- `learn: <question> = <answer>` (also `learn that <question> means <answer>`)
- `what have you learned`
- `forget <number>`
- any stored question, asked in your own words — answered with no Gemini call.

**Local first.** In the dashboard, everything is checked on this computer before
the AI is considered: the knowledge base, your notes (`remember …`), your
reminders (`remind me to …`, `what are my reminders`), the time and date,
diagnostics, My Hands, the rooms, opening and closing the windows, mute. A
command that asks the computer to do something the build has no local tool for
(drafting an email, for instance) is answered honestly — with the offer to spend
one Gemini call (say "… — use the AI") — rather than quietly spending it.

## What is not done yet

- The starter set is small (32 answers). It grows as you teach it, and as Gemini answers are kept.
- General facts (for example, a country's capital) are answered from Gemini the first time, not from
  an offline encyclopedia. A fully offline answer for those would need a large local dataset or a
  local language model. That is a decision for you (download size, speed, licence).

## What works with no internet

Saved answers (starter, taught, and kept Gemini answers) work with no internet at all —
they are words on this computer. Local commands do too: the time and date, notes,
reminders, the rooms, the windows, My Hands, diagnostics, and *this computer's voice* as
well as the browser's own voice. **Fresh, open-ended answers do not**: they are written by
Gemini, which needs the internet. There is no on-device generative model in this app — a
stale answer used because Gemini could not be reached is labelled as exactly that, never
passed off as a fresh one. (`core/llm_client.py` is an unwired client for a local model
such as Ollama; nothing in the app calls it yet.)
