# Self-repair and improvement

**Status (2026-10-09): part 1 built.** The safety layer works: rules, snapshots, trial on a copy, owner
approval, health check with automatic rollback, and rollback from chat. **Not built yet:** the assistant
writing its own proposals (that needs the model-callable tools in V2-5). Until then, a proposal can come
only from code on the server.

Owner decisions taken on 2026-10-09:
- Rollback is always available. A failed health check rolls back at once and says so.
- Essential sections stay protected: prompt, memory, config, keys, permission and repair code, the legacy app.
- Snapshots are kept until you delete them.
- Repairs can start from your chat request and from an error the assistant notices. Each one needs your approval.
- The repair code itself is protected for now. We will decide about it when we get to it.


## 1. Goal

Self-repair and improvement are the main goal of this project. The assistant should notice faults, explain
them, propose a fix or an improvement, and apply it only after you approve. It should look after itself the
way a careful person does: keep a way back, check its work, and warn before doing anything risky.

## 2. Rules

1. **Ask first, every time.** No change to the code runs without your explicit approval for that change.
   The approval shows the plain-language reason, the files and their size, the risk level, and the test
   result.
2. **Preserve itself.** Before any change:
   - take a snapshot of every file that will change (kept in `runtime/snapshots/`, with checksums);
   - apply the change to a copy first, not to the running app;
   - run the full test suite on the copy. If anything fails, the change is not applied;
   - apply the change, then run a health check (the full test suite, in a new process, on the changed project);
   - if the health check fails, roll back from the snapshot and tell you (decided 2026-10-09).
3. **Warn before danger.** Each proposal has a risk level:
   - **Low:** a fix inside one module, tests pass, no new permissions or network use.
   - **Medium:** several modules, a new dependency, or a change to how a feature behaves.
   - **High:** touches the permission policy, confirmations, the key handling, the memory or config code,
     the prompt, or the self-repair code itself. High risk needs a separate, explicit confirmation and a
     written warning of what could go wrong.
   Any proposal the assistant cannot test fully is marked "not fully tested" and cannot be applied without
   a warning you accept.
4. **Protected, never changed by self-repair:**
   - `core/prompt.txt` (the personality). You are reworking it yourself.
   - `memory/long_term.json`, `memory/recent_dialogue.json`, `memory/memory_archive.json`,
     `memory/dialogue_archive.jsonl` and `config/api_keys.json`. Memory changes go through the memory
     tools you already approve (search, restore), not through code changes.
   *Decide:* whether this list may change, and by whom.
5. **Where it may run.** Self-repair runs on the computer (server) only. It is never started from the
   browser, and the browser never gets code execution. The permission policy keeps `code.self_modify` BLOCKED
   for the browser. A desktop-only action, `code.repair`, is CONFIRM and needs a separate desktop policy
   (V2-5).
6. **Improvements are proposals.** The assistant may suggest an improvement from what it observes (for
   example, a slow search or a repeated error). It does not start one by itself.
7. **Everything is recorded.** Each proposal, approval, refusal, test result, snapshot and rollback goes
   to the event stream and to `runtime/repair_log.jsonl`. Nothing is deleted from that log.

## 3. The cycle

1. **Observe:** a failing test, an error in the event stream, or a failed health check.
2. **Diagnose:** the assistant explains the cause in plain words, with the files involved.
3. **Propose:** a patch, the risk level, and the tests it will run.
4. **Approve:** you accept, refuse, or ask for changes.
5. **Trial:** snapshot, apply to a copy, run the tests.
6. **Apply and check:** apply, health-check, keep or roll back. Report the result.

## 4. What it can and cannot change

- **Can (after approval):** code in `backend/`, `web/`, `tests/` and `tools/`, and the skill modules.
- **Cannot:** the protected files in rule 4; the permission policy's BLOCKED entries; the key handling, unless
  the change is high risk and you confirm it separately.
- **Self-repair cannot change its own approval rules** (this document, the confirmation code, and the
  snapshot and rollback code) without a high-risk confirmation.

## 5. Decisions (answered 2026-10-09)

1. Automatic rollback: yes, at once, with a report. Rollback is also available by chat command at any time.
2. Protected list: kept as in section 4.
3. Repair code: protected for now. To be decided later.
4. Snapshots: kept until you delete them.
5. Start: both, as above.

## 5a. What was built (part 1)

| Piece | File | What it does |
|---|---|---|
| Rules | `backend/repair/policy.py` | Refuses protected sections, paths outside the allowed areas, bad paths, too many or too large files. Rates risk low, medium or high, with warnings |
| Snapshots | `backend/repair/snapshots.py` | Saves the files a change will touch, with checksums. Checks every saved copy before restoring, so a damaged snapshot writes nothing |
| Trial | `backend/repair/trial.py` | Copies the project without the owner's data, applies the change to the copy and runs the full test suite there |
| Engine | `backend/repair/engine.py` | propose (rules, trial, ask), apply (snapshot, write, health check, automatic rollback), rollback (itself snapshotted first), log |
| Chat | `backend/router.py`, `backend/agent.py` | "roll back the last change" (asks first), "list snapshots" (read-only) |
| Log | `runtime/repair_log.jsonl` | Every step. Never trimmed |

Tests: `tests/test_repair.py` (45 tests). They cover refused paths, the risk levels, approval, a failing trial,
a failing health check, rollback and undoing a rollback, a damaged snapshot, owner data staying unchanged, and
the chat commands.

**Smoke test on the real project:** a no-op proposal went through the trial (full suite, about 18 seconds). It
waited for approval and nothing was changed. I did not approve it.

**Browser:** there is no web address for proposing a change. The browser can ask for a rollback in chat, and
you approve it in the confirmation panel. The browser never sends code.

**Restart:** an approved change takes effect after the app restarts. The health check runs in a new process,
so it checks the new code.

## 5b. Assistant-drafted fixes and the live drill (built 2026-10-09)

| Piece | File | What it does |
|---|---|---|
| Model call | `backend/chat.py` (`ChatService.complete`) | One stateless request with its own fixed instruction. No persona, no chat history. The key stays on the server |
| Drafting | `backend/repair/proposer.py` | Reads the named project files (only allowed ones, 60 000 bytes at most), builds the prompt, reads the answer. The answer must be JSON with a reason and the new file texts. Anything else is refused |
| Chat | `backend/router.py`, `backend/agent.py` | "propose a fix for `<file>`: `<what to change>`". Each draft uses one unit of the daily budget |
| Permission | `backend/permissions.py` | `repair.propose` is CONFIRM. Asking for a draft sends the text of the named project files to Gemini, so the owner is asked first (changed 2026-10-09 from SAFE). Memory, saved keys and the personality prompt are never sent |
| Approval | `backend/repair/engine.py` | A draft that passes the rules and the tests on a copy still waits for approval (`repair.apply`, asks each time) |
| Drill | `tools/repair_drill.py` | Runs on a copy in a temporary folder. See below |

Tests: `tests/test_repair_proposer.py` (17 tests). Recorded fake model, so no real Gemini call was made. They cover
what is sent (only named, allowed files; no memory, keys or persona), the reading of the answer (plain, fenced,
broken, wrong shape), a good draft waiting then applied on approval, a broken draft rejected by the tests, a draft
that touches owner data refused, an unreadable answer changing nothing, no budget and no key making no request.

**Live drill (run 2026-10-09, all checks passed).** Target: `backend/devices.py`, the camera device registry used
by My Hands. Everything happened on a copy in `/tmp`; the real project was checked before and after and did not change.

- **A. Broken change, offered the normal way:** rejected by the tests on the copy. Nothing was offered to the owner.
- **B. Broken change pushed straight to the apply step** (this skips the copy-test on purpose, to test the safety net):
  the health check failed, the app rolled back automatically and said so. The file was back to its exact original contents.
- **C. Good change:** waited for approval, was applied after approval, and the undo put the file back exactly.

**Known gaps:**
- The assistant cannot call the repair tools as a model tool. That comes with V2-5.

## 5c. Errors the assistant notices (built 2026-10-09)

When a request makes the app fail inside one of its own files, the app adds a note to the chat:
"I noticed an error in `<file>` (line N, `<kind>`). Nothing has been changed. If you want it fixed, say: propose a fix for …".

- Only the kind of error, the file and the line are kept. The error message is not kept, because it can contain private text.
- Only files the self-repair rules allow are offered. An error in protected code (for example `backend/repair/`) is not offered.
- The same error is not shown again for five minutes. The last 20 are kept.
- Ask "what errors have you noticed" to list them. Nothing is changed by noticing.
- **Limit:** errors that happen in background threads (for example the voice relay) are not noticed here. The voice relay reports its own errors in the voice panel.

Tests: `tests/test_repair_notices.py` (11 tests).

## 5d. Next

- Background-thread errors: connect them to the same notes.
- A drill of the notice-and-fix flow on the copy, using the chat commands end to end.
