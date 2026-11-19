# Maestro

Deutsch: [README.de.md](README.de.md)

Maestro is a mod with a skill for the Code tab of the Claude desktop app. One master session takes your requests and hands them to worker sessions with a fitting model. It watches progress, limits and context, and it archives finished sessions. A live band above the prompt shows what each worker session is doing.

```
🎼 Music  📌 2  ❓1 🔄2 ☑️1  ▰▰▰▱▱ 58 %  5h 25 %  ready
❓ color-pick ▰▰▱▱▱ 40 % · Which color?
🔄 layout-build ▰▰▰▱▱ 50 % · Build band
🔄 mix ▱▱▱▱▱ 0 % · Read in tracks
☑️ knowledge ▰▰▰▰▰ 100 % · Existing notes merged
```

The band always sits between the chat history and the prompt and shows the essentials in a small space. The header stays one line; when space gets tight, it shortens the text first.

| Icon | Meaning |
|---|---|
| 📌 | this many open items are on the list |
| `5h 25 %` | 5-hour limit, highlighted with ⚠️ from 80 % |
| ❓ | waiting for you: a question or an approval card |
| ⚠️ | no report for more than 20 minutes, or as its own row: file conflict |
| 🔄 | working |
| ⏸️ | round finished, but the task list is not |
| ☑️ | the session reported itself done, Maestro has not checked it yet |
| ✅ | checked by Maestro, disappears after 30 minutes |

The band is display only, with at most 5 rows. If not all sessions fit, the most urgent ones are on top and the rest are counted in a summary row (`… and 3 more: 🔄1 ☑️2`).

You do all your input at Maestro: it forwards your answers to sessions and stops them when you say so. Only approval cards, choice questions and attachments technically stay in the window of the session in question.

The skill text is English. Maestro answers in your language.

## Open items

No good idea should fall by the wayside. Maestro keeps its own suggestions, unanswered questions, things put off, and open questions from the sessions' reports in a list (`open_add`) and gives the count at the end of every reply. The list survives `/clear` and restarts. An item goes away only with evidence or on your word (`open_close`, required field `reason`).

The mod helps in two ways: every message you send brings the open list along to Maestro, and a keyword check reminds it when its reply sounds like a suggestion or question but nothing was recorded. The check records nothing itself.

## Install

In the desktop app: **+** next to the input field, then **Plugins**, **Add marketplace** with `fadenshine/maestro`, then **Add plugin**.

In the terminal, at a session's prompt:

```
/plugin install maestro --marketplace fadenshine/maestro
```

Or from the shell:

```
claude plugin install maestro --marketplace fadenshine/maestro
```

Then open a new chat and call the skill `maestro`. If a Maestro is already running, `/reload-plugins` in its chat reloads the mod.

## Coming from dirigent

Maestro is the renamed dirigent (0.9.0). To keep your data, run:

```
node tools/migrate-from-dirigent.mjs
```

It copies open items, skill statistics, handoffs and master entries from `~/.claude/dirigent/` into `~/.claude/maestro/`. The old folder is not changed. Old task markers `⟦dirigent:…⟧` are no longer recognized.

## Managing skills

Maestro helps make sure fitting skills are used and maintained. It assigns fitting skills to worker sessions in the task line `Skills:`, the mod records which skills are really loaded (the band shows `[name]`, or `[name?]` if the skill is not loaded yet), and the tool `skills_status` sums up usage, gaps and cleanup candidates. `skills_status` does not know built-in skills (such as `update-config`); the master takes those from its own skill list. `skill_note` records notes on skills; drafts under `proposals/` grow out of them.

When a skill is changed, `skill_change` remembers the date and the backup. `skills_status` then compares success rate and notes before and after; below 5 uses per side it says there is not enough data. If things get worse, Maestro suggests restoring the backup.

If a third-party skill or plugin from the internet fits and would make work on the project clearly more efficient, Maestro suggests that too: on its own at most once per project and at most 3 at a time, each with name, link, benefit, source and risk. A cheap, read-only session does the research and checks origin, maintenance, license, permissions and content; it downloads nothing and runs nothing. If it finds nothing clearly better, you hear nothing about it. Every suggestion ends up as an open item, and whatever you decline does not come back, with the reason kept.

Maestro **only suggests**. It changes no skill without your word, installs third-party skills only on your explicit word for exactly that suggestion, and changes no settings itself; to hide rarely used skills, `skills_hide` only returns a command that you run yourself. Cleanup candidates appear only after 30 days of log.

## Before you use it

- **Maestro works with broad approvals.** It switches its session to auto mode (the app asks you once), and worker sessions inherit it. They are told to work on their own, without asking back. They should permanently delete, publish, push or send messages to other people only if your task says so explicitly. This is an instruction to the model, not a technical lock. Use Maestro only for work where you can live with that.
- **It uses up your limits faster**, because several sessions run at the same time.
- **It archives finished sessions automatically** and clears its own chat when the context gets full.
- **Desktop app only.** It needs the app's session tools; it does not work in the plain terminal or with `claude -p`.
- **Early interface.** Claude Code calls the mod interface "early access"; an update can break the mod.

## Where things are

Everything stays on your computer; the mod sends nothing to the network. It only calls local services of the app (title, limit). Only a research session for skill suggestions searches the web, like any session that is allowed to; it sends search queries about the project out.

| What | Where |
|---|---|
| Status of each session (task list, short summary) | `~/.claude/maestro/status/` |
| `local_…` id and changed files of each session | `~/.claude/maestro/extra/` |
| Which sessions Maestro has checked | `~/.claude/maestro/checked/` |
| Open items per Maestro | `~/.claude/maestro/open/<code>.json` |
| Skill log (which session loaded which skills), notes and changes on skills | `~/.claude/maestro/skills/` (`usage`, `notes`, `changes`) |
| Drafts for new skills and change proposals (not active) | `~/.claude/maestro/proposals/` |
| Skill backups before a change | `~/.claude/maestro/skill-backup/` |
| Maestro's handoffs | `~/.claude/maestro/handoff-<code>.md` |
| Mapping of master and worker sessions | the mod's storage under `~/.claude/plugins/store/` |

## Limits

- The band is only as current as the sessions' task lists; every task therefore requires keeping the list.
- If the app resumes a session after a restart, it gets a new session id. The mod recognizes it by the app's host id and keeps status, project and open items. In the terminal there is no host id; there a resumed session starts with a new id and without Maestro.
- Status files stay on disk but are no longer read after 7 days. A ☑️ that was never checked disappears then too.
- Crashed sessions show ⚠️ after 20 minutes and disappear after 24 hours.
- File conflicts: the band warns when two sessions that are not yet checked have changed the same file, even if one has already reported done. Only the check (✅) or the end of a session takes it out of the comparison. This is detected only for `Write`, `Edit` and `NotebookEdit`, also from subagents. What a session changes through Bash (`sed`, `git`, scripts) cannot be tracked. Sessions in their own worktrees have other paths and do not count as a conflict.
- The band can hide the end of the chat. The app lays the input column with the band over the end of the chat and keeps it clear only while the chat is following along. If you have scrolled up or clicked into the chat, new replies keep running behind it; scrolling all the way down once turns following back on. The mod can neither place the band elsewhere nor move the chat itself; it only keeps the band small.
- After `/reload-plugins` the band disappears briefly until the reloaded mod draws again.
- The keyword check for open items sometimes reminds for no reason and misses things phrased differently. Maestro makes the list reliable, not the check.
- The limit in the band comes from `get_usage` and is read at most once a minute. If that fails, the band shows nothing for it.
- Tested only on a Mac with Claude Code 2.1.325.

## Develop

```
claude plugin validate .
claude plugin test .
```

## License

MIT, see [LICENSE](LICENSE).
