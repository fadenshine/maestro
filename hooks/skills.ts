import type { EngineInterface } from 'claude-code'

// Skill management of Maestro: record and evaluate usage. Everything stays in local files.
// Each session writes only its own file, so concurrent processes do not overwrite each other.
const ROOT = '/.claude/maestro/skills'
const DAY = 24 * 60 * 60 * 1000
const PERIOD = 30 * DAY

export type Usage = {
  sessionId: string
  code: string | null
  name: string | null
  task: string
  assigned: string[]
  loaded: { skill: string; time: number }[]
  result: 'running' | 'done' | 'paused'
  last: number
}

export type Note = { skill: string; kind: string; text: string; time: number }
export type SkillInfo = { name: string; description: string }
/** A skill change that was put in place: from `time` on everything counts as "after"; `backup` is the state before. */
export type Change = { skill: string; time: number; backup: string }

// Below this many uses per side, a rate is chance.
const ENOUGH_USES = 5

// Reads what the mod needs from a task brief: the lines `Task:` and `Skills:`.
// `assigned` is null when the message has no `Skills:` line (a follow-up message then changes nothing).
export function readTask(text: string) {
  const task = /^Task:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? ''
  const line = /^Skills:[ \t]*(.*)$/m.exec(text)?.[1]
  const assigned =
    line === undefined
      ? null
      : line
          .split(',')
          .map(s => s.trim())
          .filter(s => s && !/^(none|-)$/i.test(s))
  return { task: task.slice(0, 160), assigned }
}

function side(usages: Usage[], notes: Note[], skill: string, from: number, to: number) {
  const hits = usages.flatMap(n =>
    n.loaded.filter(g => g.skill === skill && g.time >= from && g.time < to).map(() => n.result),
  )
  // What is still running has no result and does not count against the skill.
  const finished = hits.filter(e => e !== 'running')
  return {
    uses: finished.length,
    successRate: finished.length ? Math.round((100 * finished.filter(e => e === 'done').length) / finished.length) : null,
    notes: notes.filter(h => h.skill === skill && h.time >= from && h.time < to).length,
  }
}

// For each change, compares usage since the previous change with usage up to the next one.
export function effect(changes: Change[], usages: Usage[], notes: Note[]) {
  const sorted = [...changes].sort((a, b) => a.time - b.time)
  return sorted.map(a => {
    const sameSkill = sorted.filter(x => x.skill === a.skill)
    const nr = sameSkill.indexOf(a)
    const from = nr > 0 ? sameSkill[nr - 1].time : 0
    const to = sameSkill[nr + 1]?.time ?? Number.MAX_SAFE_INTEGER
    const before = side(usages, notes, a.skill, from, a.time)
    const after = side(usages, notes, a.skill, a.time, to)
    const enough = before.uses >= ENOUGH_USES && after.uses >= ENOUGH_USES
    const rate = (after.successRate ?? 0) - (before.successRate ?? 0)
    const noteRate = after.notes / Math.max(after.uses, 1) - before.notes / Math.max(before.uses, 1)
    const trend = !enough ? null : rate <= -10 || noteRate >= 0.2 ? 'worse' : rate >= 10 ? 'better' : 'same'
    return {
      skill: a.skill,
      date: new Date(a.time).toISOString().slice(0, 10),
      backup: a.backup,
      before,
      after,
      trend,
      ...(enough ? {} : { note: `not enough data: each side needs ${ENOUGH_USES} uses` }),
    }
  })
}

export function evaluate(skills: SkillInfo[], usages: Usage[], notes: Note[], now: number, changes: Change[] = []) {
  const since = usages.reduce((early, n) => Math.min(early, n.loaded[0]?.time ?? n.last), now)
  const table = skills.map(skill => {
    const hits = usages.flatMap(n => n.loaded.filter(g => g.skill === skill.name).map(g => ({ ...g, result: n.result })))
    const latest = hits.reduce((late, t) => Math.max(late, t.time), 0)
    return {
      name: skill.name,
      description: skill.description.slice(0, 160),
      loaded: hits.length,
      done: hits.filter(t => t.result === 'done').length,
      lastUsedDaysAgo: latest ? Math.floor((now - latest) / DAY) : null,
      assignedNotLoaded: usages.filter(n => n.assigned.includes(skill.name) && !n.loaded.some(g => g.skill === skill.name)).length,
      openNotes: notes.filter(h => h.skill === skill.name).length,
    }
  })
  return {
    logDays: Math.floor((now - since) / DAY),
    skills: table,
    // Raw material for gaps: tasks without a loaded skill. Whether they are alike is for Maestro to judge.
    tasksWithoutSkill: usages
      .filter(n => n.task && n.loaded.length === 0 && now - n.last < PERIOD)
      .map(n => ({ task: n.task, daysAgo: Math.floor((now - n.last) / DAY) })),
    notes: notes.map(h => ({ skill: h.skill, kind: h.kind, text: h.text, daysAgo: Math.floor((now - h.time) / DAY) })),
    changes: effect(changes, usages, notes),
    // Only meaningful after a full month of log.
    cleanupCandidates:
      now - since < PERIOD
        ? []
        : table.filter(t => t.lastUsedDaysAgo === null || t.lastUsedDaysAgo * DAY >= PERIOD).map(t => t.name),
  }
}

async function jsonFiles($: EngineInterface, folder: string) {
  const list: unknown[] = []
  if (!(await $.fs.exists(folder))) return list
  for (const file of await $.fs.list(folder)) {
    if (!file.name.endsWith('.json')) continue
    try {
      list.push(JSON.parse(await $.fs.read(`${folder}/${file.name}`)))
    } catch {
      // A half-written file counts next time.
    }
  }
  return list
}

export async function writeUsage($: EngineInterface, usage: Usage) {
  try {
    const home = await $.env.get('HOME')
    await $.fs.write(`${home}${ROOT}/usage/${usage.sessionId}.json`, JSON.stringify(usage))
  } catch {
    // The log must never hold up the work.
  }
}

export async function writeNote($: EngineInterface, note: Note) {
  const home = await $.env.get('HOME')
  const name = `${note.time}-${note.skill.replace(/[^\w.-]/g, '_')}.json`
  await $.fs.write(`${home}${ROOT}/notes/${name}`, JSON.stringify(note))
}

export async function writeChange($: EngineInterface, change: Change) {
  const home = await $.env.get('HOME')
  const name = `${change.time}-${change.skill.replace(/[^\w.-]/g, '_')}.json`
  await $.fs.write(`${home}${ROOT}/changes/${name}`, JSON.stringify(change))
}

// A session's own log, to continue it after a restart instead of overwriting it.
export async function readUsage($: EngineInterface, sessionId: string) {
  const home = await $.env.get('HOME')
  const path = `${home}${ROOT}/usage/${sessionId}.json`
  if (!(await $.fs.exists(path))) return undefined
  return JSON.parse(await $.fs.read(path)) as Partial<Usage>
}

// A resumed session gets a new id. Its log moves along; the old file stays behind empty,
// otherwise its uses would count twice and its task as "without skill".
export async function moveUsage($: EngineInterface, oldId: string, newId: string) {
  const old = await readUsage($, oldId)
  if (!old) return
  const home = await $.env.get('HOME')
  if (!(await readUsage($, newId))) {
    await $.fs.write(`${home}${ROOT}/usage/${newId}.json`, JSON.stringify({ ...old, sessionId: newId }))
  }
  await $.fs.write(`${home}${ROOT}/usage/${oldId}.json`, JSON.stringify({ ...old, task: '', assigned: [], loaded: [] }))
}

export async function skillsStatus($: EngineInterface) {
  const home = await $.env.get('HOME')
  const now = await $.clock.now()
  const commands = await $.command.list()
  const skills = commands
    .filter(c => (c.source as string) !== 'builtin' && (c.source as string) !== 'mcp')
    .map(c => ({ name: c.name, description: c.description }))
  const usages = (await jsonFiles($, `${home}${ROOT}/usage`)) as Usage[]
  const notes = (await jsonFiles($, `${home}${ROOT}/notes`)) as Note[]
  const changes = (await jsonFiles($, `${home}${ROOT}/changes`)) as Change[]
  return evaluate(skills, usages, notes, now, changes)
}

// Builds the command the user runs to hide skills themselves. `name-only` keeps them usable
// but saves their description in the context of every session. The mod changes no settings.
export function hideCommand(names: unknown) {
  const list = Array.isArray(names) ? names.map(String) : []
  const valid = list.filter(n => /^[\w:.-]+$/.test(n))
  const rejected = list.filter(n => !valid.includes(n))
  if (valid.length === 0) return { command: null, rejected }
  const entries = valid.map(n => `"${n}":"name-only"`).join(',')
  const file = '~/.claude/settings.json'
  return {
    command: `cp ${file} ${file}.before-skill-cleanup && jq '.skillOverrides = ((.skillOverrides // {}) + {${entries}})' ${file} > ${file}.new && mv ${file}.new ${file}`,
    rejected,
  }
}
