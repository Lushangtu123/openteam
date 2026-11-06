# 项目模式 (project mode)

A group's members work on one goal as a team: a coordinator breaks the goal into tasks, OpenTeam hands the tasks out, and the coordinator checks the results and re-plans until it can write the final deliverable. Everything shows on a task board at the end of the chat.

## Flow

1. **Start.** The 项目 button in the group header opens a window: the goal (the message box's text is offered), files (PDF, Word, Excel, PowerPoint or text; images are not taken yet), the coordinator (an API member by default, as it is quicker and steadier) and a step limit (20, 30 or 50).
2. **Plan.** The coordinator gets the goal, the files, the members (name, model, responsibility) and anything the user added, and answers with a JSON block: 2–8 tasks, each with an owner, `dependsOn`, what to do and `doneWhen`. Owners are matched by name; unknown owners fall back to the coordinator; missing dependencies are dropped and a plan with a dependency cycle is refused. A plan that cannot be read is asked for once more.
3. **Approve.** The board lists the tasks. The user can change owners, write what to change in the message box and click 重新规划, cancel, or click 开始执行.
4. **Work.** Every task whose dependencies are done goes out at once (one task per member at a time), so independent tasks run side by side. A task's prompt carries the goal, the files, the task and its done criteria, the full results of the tasks it depends on, the coordinator's feedback on a redo, and the user's notes. The member ends with `【状态】完成` (or `受阻：原因`) and `【摘要】…`; a reply without them counts as done. A task that gets no reply is tried again, up to three tries in all.
5. **Check.** When nothing is running and nothing more can start, the coordinator checks: new results in full, earlier ones by their summary. It answers with JSON: a verdict per task (`pass`, `redo` with a note, `reassign` with a new owner), optional new tasks (12 at most in all), an optional question for the user, and `finish`.
6. **Question.** A question pauses the project; the board shows it, and the user answers in the message box, which lets the project go on.
7. **Finish.** When everything has passed (or the coordinator finishes with what there is), the coordinator writes the final deliverable from all results. It shows as a 最终交付 card.

## Limits and control

- Every request to a member is a step. When the steps run out the project stops; 继续执行 adds 10. The final write-up may take one step past the limit, so finished work is not lost.
- 停止项目 stops it at once: members writing finish, nothing new is sent. 继续执行 picks it up again (a cancelled plan goes back to waiting for approval).
- Messages the user sends while a project runs are notes for the coordinator (no attachments); they are not sent to members directly.
- Desktop notifications (when OpenTeam is not in front): plan ready, a question, finished, stopped — once each.

## Implementation

- Rules and prompts: `src/group/project.ts`. Runner: `src/background/projectRunner.ts`, wired into `messageHandlers.ts` (routes `GROUP_PROJECT_START`, `_APPROVE`, `_REPLAN`, `_SET_OWNER`, `_STOP`, `_CONTINUE`). Page: `src/teamPage/projectView.ts` (start window, board).
- State is `GroupChat.project` (`ProjectRun`, with its `ProjectTask`s). Each step is a user-type request to one member with `projectRequest: { kind, taskId? }`, sent through the same delivery as any message, so web and API members both work. Replies arrive as usual; when one settles, the runner takes the next step about 1.5 s later.
- Project requests are OpenTeam's own instructions: they are left out of members' context, reply choices and notifications. Plan, check and write-up requests do not count as the member's own conversation, so its persona still goes with its first real message; task requests do, and carry the persona the first time.
- Plans and checks are JSON for OpenTeam; in the chat they are folded under a title, the raw reply a click away.

## Verified

- Unit tests: plan and check parsing, task outcomes, readiness, prompts, the runner end to end with two API members (parallel tasks, a dependent task, a redo, two checks, the write-up; a question answered from the message box; stop and continue), the board, the start window and the notifications.
- Chrome for Testing, three signed-out Gemini members (November 2026): a one-page flyer for a book club. The coordinator planned three tasks (策划 → 文案 → its own check of both), the user approved, the tasks ran in order, the check passed everything and the final deliverable came back complete — 6 steps.
