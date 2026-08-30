# Deep Plan

Deep Plan is an optional requirements-gathering policy layered over the existing
Plan mode. It is not a third interaction mode, does not approve a Plan, and does
not execute work.

## Enable it

In the TUI:

~~~text
/setting deepplan on
~~~

Or in the user config:

~~~toml
[agent]
deep_plan = "on"
~~~

The default is off. The value is user-only, so a repository cannot enable the
question loop through project configuration. A live setting change applies to
the next Plan message and never changes a turn already in progress.

## How it works

1. Enter Plan mode with Shift+Tab or /mode plan.
2. Submit the planning request.
3. The agent inspects repository and conversation evidence first.
4. If material product decisions remain, it opens one questionnaire containing
   one to four related questions.
5. Submitted answers return to the same agent turn. The agent can inspect more,
   ask a follow-up batch, or write the structured Plan Contract with todo.write.
6. The host checks both ordinary Plan readiness and Deep Plan readiness before
   accepting a final response.
7. A ready Plan continues into the existing digest-bound review and approval UI.

If the request and repository already determine every material decision, Deep
Plan writes the Plan directly without ceremonial questions.

## Questionnaire controls

| Key | Action |
| --- | --- |
| Up/Down, Ctrl+P/Ctrl+N | Move within the active choice list |
| Tab/Right | Next question |
| Shift+Tab/Left | Previous question |
| Space | Toggle the active multi-select choice |
| Enter | Select, advance, or submit on the last question |
| Ctrl+Enter | Submit when every required answer is present |
| 1–9 | Select or toggle a numbered option |
| Esc | Open the pause menu without discarding drafts |

Text and custom-answer rows edit inside the questionnaire. Ctrl+B/Ctrl+F move
the text cursor, Backspace removes one grapheme, and Ctrl+U clears the current
text answer.

The pause menu can return to the questions, write the Plan now with current
answers, pause Deep Plan, or cancel the current Deep Plan. “Write the Plan now”
turns unanswered decisions into explicit assumptions or open decisions; it
never silently invents an answer.

## Resume and retries

Questionnaire identity is stable:

- questionnaireId makes provider retries idempotent.
- decisionKey prevents an already resolved decision from being asked again.
- A conflicted decision can be revisited only with a stated revisitReason.

The journal persists the pending questionnaire, active tab, draft answers,
decision ledger, submitted results, and the Plan revision that followed the
latest answers. A detached daemon controller can use the App methods
turn.input.get, turn.input.update, and turn.input.resolve to continue the
original worker-owned turn. After a process restart, the same state is replayed
and the result indicates when a continuation turn is required.

## Headless behavior

Non-interactive runs never wait indefinitely for input. The questionnaire
returns unavailable and remains resumable in durable session state. The agent
can then proceed from repository evidence, state an explicit blocker, or
continue after an interactive controller attaches.

## Completion rules

While Deep Plan is active, a final response is accepted only when:

- no questionnaire is pending;
- no blocking decision is unresolved or conflicted;
- every required question is submitted;
- the structured Plan Contract was written during the current Deep Plan turn;
- it was written after the latest answer revision; and
- its context or assumptions reflect the blocking user choices.

An early final is preserved as intermediate commentary, followed by a
DEEP_PLAN_INCOMPLETE continuation directive in the same turn. Paused and
cancelled questionnaires bypass that continuation rule so they cannot create an
infinite question loop.

Plan mode's existing read-only tool boundary, Plan digest, approval, execution,
and rollback rules are unchanged.
