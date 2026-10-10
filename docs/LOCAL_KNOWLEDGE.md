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
| gemini | a Gemini answer, kept so the same question is not paid for twice. Shown as "saved from an earlier Gemini answer, <date>" | yes, after 30 days (`SUPPER_KNOWLEDGE_DAYS`) |

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
- A damaged file is kept aside as `knowledge.json.bad-<time>`, and the store starts again. Nothing is lost.
- Expired and forgotten entries go to the archive list in the same file.

## What is not done yet

- The starter set is small (32 answers). It grows as you teach it, and as Gemini answers are kept.
- General facts (for example, a country's capital) are answered from Gemini the first time, not from
  an offline encyclopedia. A fully offline answer for those would need a large local dataset or a
  local language model. That is a decision for you (download size, speed, licence).
