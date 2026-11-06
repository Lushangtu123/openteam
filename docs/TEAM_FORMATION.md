# Team formation: AIs choose their own positions

"按任务组队" (Team up for a task) builds a group around a task. You describe the task and pick the AIs; each AI then decides which position on the project suits it. You confirm the result before any work starts.

## Flow

1. **Setup window** (new-chat popover → 按任务组队): the task, the members (any chat site or API model, the same one up to 3 times, 2–6 in all), optional required positions, and an optional group name. `GROUP_TEAM_CREATE` creates a collaborative group whose members are named after their model ("Claude", "Claude2") and stores `chat.teamFormation`.
2. **Check the members**: the role card lists each member's page health (the same states as the member panel). Inviting is possible once every page can send; members with a problem can be opened or removed.
3. **Invitations, in rounds**: one copy of every model is asked first; a second copy of a model is asked once the first round has answered, and its invitation lists the positions already taken. Copies of the same model given the same prompt would otherwise pick the same position. Each invitation asks for a ```json reply: first choice, second choice, why, responsible for, not responsible for, first deliverable, and the positions the project needs. A round is sent once (`teamRound` on `GROUP_MESSAGE_SEND`), even with two team pages open.
4. **The role card** reads every member's latest claim (`collectTeamMembers`) and resolves positions (`resolveTeamPositions`):
   - a first choice nobody else wants is taken;
   - in a clash, a member that claimed earlier (answered an earlier invitation) keeps the position, and so does a position you typed;
   - otherwise one of the equals keeps it if the others can move to a free second choice;
   - what is left is a conflict: change a position by hand, or "让重复的重选" asks only the members who have to change again.
   The card also lists positions the task needs (required, or mentioned by the members) that nobody holds.
5. **Confirm**: each member is renamed to its position and gets a description and persona from its own answer. A member moved to its second choice, or given a position by hand, gets the position alone, since what it wrote describes its first choice. Then the kickoff message goes to everyone with `refreshPersona`, so the new persona reaches members that already have history (personas are otherwise sent only with a member's first message).

## Code

- `src/group/teamFormation.ts`: rounds, invitation and kickoff text, claim parsing, resolution, member names and briefs.
- `src/background/chatHandlers.ts`: `GROUP_TEAM_CREATE`, and `teamFormation` in `GROUP_CHAT_UPDATE` patches.
- `src/background/messageHandlers.ts`: `teamInvitation`, `teamRound` and `refreshPersona` on `GROUP_MESSAGE_SEND`.
- `src/teamPage/teamFormationView.ts`: the setup window, the role card, the banner, claim replies shown as a summary, and the driver that sends the next round.

Not built yet: generating an orchestration flow from the confirmed roles, saving the team as a group template, and re-dividing roles later in the project.
