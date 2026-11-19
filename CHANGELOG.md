# Changelog

## 0.9.0 – 2026-11-19

Renamed from **dirigent** to **maestro** and translated to English. New repository: `fadenshine/maestro`.

- Plugin, skill and mod are now called `maestro`; the skill text, tool descriptions, tool results and band texts are English. Maestro still answers in the user's language, and the keyword check for open items knows German and English.
- New tool names: `master_start`, `master_end`, `status`, `master_name`, `skills_status`, `skill_note`, `skills_hide`, `skill_change`, `open_add`, `open_close`, `open_list`, `session_checked` (prefix `mcp__maestro__`). Parameters and enum values are English too (for example `kind: idea`, `status: dropped`, `reason`).
- New task marker `⟦maestro:<name>@<code>⟧`; task briefs use the lines `Task:` and `Skills: … | none`.
- Data lives in `~/.claude/maestro/` (`status/`, `extra/`, `checked/`, `open/`, `skills/usage|notes|changes`, `proposals/`, `skill-backup/`, `handoff-<code>.md`).
- `tools/migrate-from-dirigent.mjs` copies open items, skill statistics, handoffs, statuses and store entries from dirigent. The old data is not changed.
- Removed the cleanup of the store format from before 0.6.0.
- Source files renamed: `hooks/offen.ts` → `hooks/open.ts`, `hooks/ausbau.test.tsx` → `hooks/features.test.tsx`.
- README in English, German version in `README.de.md`.

## 0.8.2

The mod sets the task marker itself; the master is reminded to load the skill.

## 0.8.1

Band as a pure display with at most 5 rows.

## 0.8.0

Skill management, open items, buttons, and recognition after a restart.

## 0.6.0

Band: icons, percentages and shortened text per session.
