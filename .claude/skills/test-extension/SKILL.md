---
name: test-extension
description: Multi-agent QA sweep of the AI Web Annotator Chrome extension. Spawns an agent team (functional tester, UI reviewer, adversarial tester, critic) that drives the real Chrome via claude-in-chrome, peer-reviews each other's findings, and writes a confirmed/unconfirmed report to qa/runs/. Requires CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 (set in .claude/settings.json).
---

# Extension QA Team Protocol

You are the **team lead**. You coordinate; you do not test. Your teammates do the browser work and review each other. Your jobs: preflight, spawn, task plan, dispute arbitration, final report.

## Preflight — all must pass before spawning anyone

1. **Agent teams available.** If you cannot spawn teammates, the session was started without `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` — tell the user to restart Claude Code (the flag is in `.claude/settings.json`) and stop.
2. **Browser reachable.** Load the claude-in-chrome tools (one ToolSearch call) and call `tabs_context_mcp`.
3. **Extension alive.** Open a tab to any site from `qa/test-sites.json` and check `!!document.getElementById('wa-sidebar')` via the javascript tool. If false, stop and tell the user to load/reload the unpacked extension at `chrome://extensions` (you cannot do this yourself).
4. **Model pin (user step).** All test runs must use **Gemini 2.5 Flash** for cost control. You cannot set or read this yourself — the browser tools refuse `chrome-extension://` pages, and page-context JS cannot reach the extension's storage. Ask the user: *"Open the extension popup and set provider Google Gemini, model Gemini 2.5 Flash, then confirm."* Wait for confirmation before spawning the team. Enforcement is automated downstream: every annotation card displays the model that produced it (the `.wa-cost-model` span), and testers verify it on their first Explain — a mismatch pauses the run.
5. **Cost notice.** Tell the user roughly how many real API calls this run will make (~1 per span in the manifest + up to ~6 adversarial), all on Gemini 2.5 Flash.

## Run setup

1. `RUN_ID` = current `YYYY-MM-DD-HHMM`. Create `qa/runs/$RUN_ID/findings/` and `qa/runs/$RUN_ID/recordings/`.
2. Write `qa/runs/$RUN_ID/RUN.md` from the template at the bottom of this file (fill in run id, date, `git rev-parse --short HEAD`, and copy the site list).

## Recordings

Every browser-phase task is recorded as an annotated GIF (click indicators, action labels), so the user can replay exactly what each agent saw and did. The convention, which the browser-phase agent definitions implement:

- One recording per site task: `qa-$RUN_ID-p<phase>-<site-id>.gif` (plus `qa-$RUN_ID-p3-cleanup.gif`).
- `gif_creator` export downloads through Chrome, so the file lands in `~/Downloads`. Immediately after export, the recording agent moves it: `mv ~/Downloads/<filename> <run-dir>/recordings/` (if the file isn't there yet, wait a couple of seconds and retry once; if it still isn't, note it in RUN.md and move on — never loop).
- Findings should cite their recording filename under **Evidence** so the report links claims to footage.
- Recordings are for the user's review; the critic judges findings on their written evidence, not GIFs.

## Team roster

Spawn each teammate with its agent type, an exact name, and a spawn prompt containing: the absolute run directory path, its phase number, and the instruction to read `RUN.md` and `qa/test-sites.json` before doing anything else.

| Name          | Agent type            | Model  | Browser phase |
|---------------|-----------------------|--------|---------------|
| `functional`  | qa-functional-tester  | sonnet | 1             |
| `ui`          | qa-ui-reviewer        | sonnet | 2             |
| `adversarial` | qa-adversarial-tester | sonnet | 3             |
| `critic`      | qa-critic             | opus   | none          |

## Task plan — this is what enforces the single-browser rule

There is ONE real Chrome. Two agents driving it concurrently will corrupt each other's tests. Serialize browser access through task dependencies; teammates are instructed to only touch browser tools while holding an unblocked, in-progress task.

Create tasks in this shape:

- **Phase 1** — one task per site: `P1 <site-id> functional pass`, assigned to `functional`. No dependencies.
- **Phase 2** — one task per site: `P2 <site-id> visual audit`, assigned to `ui`. Each depends on **all** P1 tasks.
- **Phase 3** — `P3 edge-case sweep` then `P3 cleanup` (cleanup depends on the sweep), assigned to `adversarial`. The sweep depends on **all** P2 tasks.
- **Review** — `Review findings (ongoing)` assigned to `critic`. No dependencies; the critic starts as soon as findings exist.

Phase ordering is load-bearing beyond the lock: phase 1 leaves annotations on every site, phase 2 audits them in place (their restoring on navigation doubles as a persistence test), phase 3 breaks things and then deletes everything.

## While phases run

- **Wait for teammates.** Do not start testing yourself, ever. If you catch yourself about to open the browser, stop.
- Relay notable mid-run findings to the user in one line each; don't narrate every task.
- If a teammate stalls or errors out, message it; if dead, spawn a replacement with the same agent type and remaining tasks.
- If a task looks done but isn't marked completed, verify and nudge the teammate (known task-status lag in agent teams).

## Peer review and disputes

The critic reviews every finding (bar and verdicts are defined in its agent definition). Your role as lead:

- When the critic requests re-verification of a disputed finding: create a task `Re-verify <finding-id>`, assigned to a tester who did **not** author it (`functional` ↔ `adversarial`; `ui` findings go to either), depending on `P3 cleanup` so the browser is free. The re-verifier recreates only what's needed, updates the finding's status with what they observed, and deletes any annotations they created.
- You arbitrate only if the critic and an author deadlock after re-verification: read both positions, decide, write your reasoning into the finding file.
- Hard rule for the report: nothing ships as **confirmed** unless the critic marked it so.

## Final report — `qa/runs/$RUN_ID/final-report.md`

Wait until all tasks are complete and the critic has finished its meta-review. Then write:

1. **TLDR** — 3–5 sentences: overall health, worst confirmed issue, best improvement suggestion.
2. **Confirmed findings** — grouped by severity (blocker/major/minor/polish); each with one-line summary, repro pointer, and evidence summary.
3. **Unconfirmed / disputed** — with why they didn't clear the bar.
4. **Improvement suggestions** — the critic-endorsed `suggestion` findings, concrete enough to act on.
5. **What was verified working** — from the testers' positive confirmations; be honest about coverage gaps the critic flagged.
6. **Run stats** — sites covered, spans tested, approximate Gemini calls made, findings filed/confirmed/rejected, recordings captured (with a pointer to `recordings/`).

Then ask each teammate to shut down, confirm cleanup happened (adversarial's RUN.md section), and give the user the report path plus the TLDR inline.

## Constraints (apply to the whole team; repeated in agent defs)

- Never navigate to `chrome://` pages. `chrome-extension://` pages (including the popup) are refused by the browser tools — the popup UI is out of automation scope; record "popup untested" in every run.
- **Model pin:** all Explain calls must run on Gemini 2.5 Flash. Testers verify the `.wa-cost-model` label on their first card; on mismatch they stop browser work and message you — pause, ask the user to fix the popup setting, then resume.
- Never trigger JS alerts/confirms — they hang the browser tools.
- Real API calls: stick to manifest spans; adversarial budget ~6 calls; exactly one Custom-mode question per run (in the manifest).
- A browser tool failing 2–3 times is a finding, not a retry loop.
- Extension reloads are manual: if the user changed extension code mid-run, results are invalid — note the git rev in RUN.md and tell the user to reload + restart the run instead.

## RUN.md template

```markdown
# QA Run <RUN_ID>

- Date: <date>
- Extension git rev: <short sha>
- LLM model: Gemini 2.5 Flash (pinned — user-confirmed in popup, enforced via card label)
- Team: functional (sonnet), ui (sonnet), adversarial (sonnet), critic (opus), lead
- Sites: <list of site ids from qa/test-sites.json>

## Finding protocol

One file per finding: `findings/NNN-short-slug.md` (NNN = zero-padded sequence, grab the next free number).

    ---
    id: F-NNN
    author: functional | ui | adversarial | critic
    site: <site-id or "general">
    phase: 1 | 2 | 3
    type: bug | ui | suggestion
    severity: blocker | major | minor | polish
    status: filed | challenged | confirmed | rejected | unconfirmed
    confirmed_by: <agent name, once independently verified>
    ---
    **Observed:** what actually happened.
    **Expected:** what should have happened (cite qa/test-sites.json `expect` where applicable).
    **Repro:** numbered steps, executable cold.
    **Evidence:** exact console output, element positions, what screenshots showed.

Status lifecycle: `filed` → critic sets `confirmed` / `challenged` / `rejected`; challenged findings are amended by the author or escalated to re-verification; anything unresolved at run end becomes `unconfirmed`.

## Per-agent sections (append your own summaries below)

### functional
### ui
### adversarial
### critic
```
