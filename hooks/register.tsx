import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BandConflict, BandState, BandRow } from '../types'
import { addItem, addReminder, closeItem, openContext, openFile, openSigns, readOpen, stillOpen, writeOpen } from './open'
import { hideCommand, moveUsage, readTask, readUsage, skillsStatus, writeChange, writeNote, writeUsage } from './skills'
import type { Usage } from './skills'

// Every task a master sends to a worker session contains `⟦maestro:<name>@<code>⟧`.
// The code says which Maestro the session belongs to; every session can have its own.
const MARK = '⟦maestro'
const NAME_IN_MARKER = /⟦maestro:([^⟧@＠]+)(?:[@＠]([0-9a-z]{8}))?⟧/
const handoff = (code: string) => `~/.claude/maestro/handoff-${code}.md`
const marker = (code: string) => `⟦maestro:<name>@${code}⟧`
const markerFor = (name: string, code: string) => `⟦maestro:${name}@${code}⟧`
const START_SESSION = 'mcp__ccd_session__start_session'
const TOOL = (name: string) => `mcp__maestro__${name}`

// Name of a worker session for the marker: the `name` from start_session, otherwise made from the title.
function sessionName(name: unknown, title: unknown) {
  const raw = typeof name === 'string' && name.trim() ? name : typeof title === 'string' ? title : ''
  const clean = raw
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/, '')
  return clean || 'session'
}

// Remembers which host id start_session gave out for which name, so follow-up messages get the marker
// even before the new session has read its task.
async function rememberTarget($: EngineInterface, code: string, name: string, answer: unknown) {
  try {
    const text = JSON.stringify(answer ?? '')
    const hostId = /local_[0-9a-f-]{36}/.exec(text)?.[0]
    if (hostId) await $.store.set(`target:${hostId}`, { name, code })
  } catch {
    // Then only the first task gets the marker; the session still signs in.
  }
}

// Name of the worker session behind a `local_…` id, if it belongs to this master.
async function targetName($: EngineInterface, code: string, to: unknown) {
  if (typeof to !== 'string' || !to.startsWith('local_')) return undefined
  const target = (await $.store.get(`target:${to}`)) as Role | undefined
  if (target?.code === code) return target.name
  for (const k of await $.store.keys()) {
    if (!k.startsWith('role:')) continue
    const role = (await $.store.get(k)) as Role | undefined
    if (role?.hostId === to && role.code === code) return role.name
  }
  return undefined
}

// `$.store` is one file for all sessions. In it, per Maestro `master:<code>` and per
// worker session `role:<sessionId>`. The code stays the same across a /clear,
// the master's session id does not.
// The session id also changes when the app resumes a session after a restart. Only the app's host id
// (`local_…`) is permanent; it recognizes a session again. The terminal has none.
type Master = { code: string; sessionId: string; since: string; project?: string; hostId?: string }
type Role = { name: string; code: string; hostId?: string }

// Title of the master session: `🎼 <project>`, at most 40 characters of project name, an existing 🎼 is dropped.
function projectName(raw: unknown) {
  const name = String(raw ?? '').replace(/🎼️?/gu, '').replace(/\s+/g, ' ').trim()

  return name.length > 40 ? `${name.slice(0, 39).trimEnd()}…` : name
}

// Helpers that receive `$` must be top-level; otherwise the engine rejects the mod.
async function allMasters($: EngineInterface) {
  const list: Master[] = []
  for (const k of await $.store.keys()) {
    if (k.startsWith('master:')) list.push((await $.store.get(k)) as Master)
  }
  return list
}

async function myMaster($: EngineInterface, sessionId: string) {
  return (await allMasters($)).find(m => m.sessionId === sessionId)
}

async function readHostId($: EngineInterface) {
  try {
    const id = await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')
    return id?.startsWith('local_') ? id : undefined
  } catch {
    return undefined
  }
}

// --- Band above the prompt -------------------------------------------------------------------
// Every session of a Maestro writes its status to its own file; the master reads them every three seconds.
// Own files instead of `$.store`: many processes write at the same time, and the master must see
// other sessions' changes at once.
type Step = { text: string; status: string }
type State = 'working' | 'waiting' | 'done' | 'ended'
type Status = {
  code: string
  name: string
  isMaster: boolean
  state: State
  steps: Step[]
  note: string
  last: number
  loaded?: string[]
  assigned?: string[]
  /** The round ended with a question: `waiting` is then worth a message, not a card. */
  blocked?: boolean
}

// What only the mod knows, in a separate file: a settings hook that writes the status file too
// overwrites every field there that it does not know.
type Extra = { hostId?: string; paths?: string[] }

type Own = {
  steps: Step[]
  note: string
  state: State
  blocked: boolean
  reported: number
  task: string
  assigned: string[]
  loaded: { skill: string; time: number }[]
  /** For this session id the status has already been restored. */
  restoredFor?: string
  hostId?: string
  paths: string[]
  extraWritten?: string
  waitingForApproval: boolean
  openAdded: boolean
}

const newOwn = (): Own => ({
  steps: [],
  note: '',
  state: 'done',
  blocked: false,
  reported: 0,
  task: '',
  assigned: [],
  loaded: [],
  paths: [],
  waitingForApproval: false,
  openAdded: false,
})

const band = atom({ plugin: 'maestro', key: 'band' } as const, null)

const MINUTE = 60_000
const CHECKED_VISIBLE = 30 * MINUTE
const QUIET_AFTER = 20 * MINUTE
const GONE_AFTER = 24 * 60 * MINUTE
const READ_PERIOD = 7 * GONE_AFTER
const HEARTBEAT = 15_000
const FOLDER = '/.claude/maestro/status'
const EXTRA = '/.claude/maestro/extra'
const CHECKED = '/.claude/maestro/checked'
const PATHS_MAX = 200
const LIMIT_WARNING = 80
// The band has at most this many rows, header included. The app lays the input column and band over the end
// of the chat and keeps only the end clear while the chat follows along (see README, "Limits"). `maxRows` does not
// protect against that: on desktop it is always 12. Every row less is chat that stays visible.
const BAND_MAX_ROWS = 5

const brief = (text: string) => {
  const line = text.split('\n')[0].trim()
  const sentence = /^.{12,}?[.!?](?=\s|$)/.exec(line)?.[0] ?? line
  return sentence.length > 140 ? `${sentence.slice(0, 139)}…` : sentence
}

// Applies an update_plan call to the steps: items replaces, advance moves on,
// done and start count from 1.
function applyPlan(steps: Step[], input: Record<string, unknown>): Step[] {
  if (Array.isArray(input.items)) {
    return input.items.map(i => {
      const item = i as { content?: unknown; status?: unknown }
      return { text: String(item.content ?? ''), status: String(item.status ?? 'pending') }
    })
  }
  const next = steps.map(s => ({ ...s }))
  if (input.advance === true) {
    const now = next.findIndex(s => s.status === 'in_progress')
    if (now >= 0) next[now].status = 'completed'
    const after = next.findIndex(s => s.status === 'pending')
    if (after >= 0) next[after].status = 'in_progress'
  }
  if (Array.isArray(input.done)) {
    for (const nr of input.done) if (next[Number(nr) - 1]) next[Number(nr) - 1].status = 'completed'
  }
  if (typeof input.start === 'number' && next[input.start - 1]) {
    for (const s of next) if (s.status === 'in_progress') s.status = 'pending'
    next[input.start - 1].status = 'in_progress'
  }
  return next
}

// Cuts down to the essentials: a lead-in up to a colon and everything after the first clause are dropped,
// the rest is cut at a word boundary if it does not fit the line.
function terse(text: string, max: number) {
  const whole = text.trim()
  const noLead = /^[^:]{1,25}:\s+(.+)$/.exec(whole)?.[1] ?? whole
  const part = noLead.split(/[.!;,](?:\s|$)|\s[–—-]\s/)[0].trim() || noLead
  if (part.length <= max) return part
  const cut = part.slice(0, Math.max(max - 1, 1))
  const space = cut.lastIndexOf(' ')
  return `${space > max / 2 ? cut.slice(0, space) : cut}…`
}

const bar = (percent: number) => {
  const full = Math.round(percent / 20)
  return '▰'.repeat(full) + '▱'.repeat(5 - full)
}

function rowFrom(status: Status, now: number, checkedAt?: number): BandRow | undefined {
  if (status.state === 'ended') return undefined
  const age = now - status.last

  const steps = Array.isArray(status.steps) ? status.steps : []
  const active = steps.find(s => s.status === 'in_progress')
  const completed = steps.filter(s => s.status === 'completed').length
  const percent = steps.length ? Math.round((100 * completed) / steps.length) : null
  // Loaded skill in brackets; assigned but not loaded yet, with a question mark.
  const loaded = status.loaded ?? []
  const missing = (status.assigned ?? []).filter(s => !loaded.includes(s))
  const skill = loaded[0] ? `[${loaded[0]}]` : missing[0] ? `[${missing[0]}?]` : undefined
  const base = { name: status.name, state: status.state, percent, skill }

  if (status.state === 'waiting') {
    return { ...base, state: 'waiting', icon: '❓', text: status.note || 'waiting for you' }
  }
  if (status.state === 'done') {
    // Round over, list not: that is not done but a pause.
    if (percent !== null && percent < 100) {
      return { ...base, state: 'done', icon: '⏸️', text: status.note || active?.text || 'paused' }
    }
    // Reported is not checked: only what the master looked at after the last report is ✅ and may go.
    if (checkedAt !== undefined && checkedAt >= status.last) {
      if (now - checkedAt > CHECKED_VISIBLE) return undefined
      return { ...base, state: 'done', icon: '✅', text: status.note || 'checked' }
    }
    return { ...base, state: 'done', icon: '☑️', text: status.note || 'reported done' }
  }
  // Crashed: nobody reports any more.
  if (age > GONE_AFTER) return undefined
  if (age > QUIET_AFTER) {
    return { ...base, state: 'working', icon: '⚠️', prefix: `${Math.round(age / MINUTE)} min quiet`, text: active?.text ?? 'no report' }
  }
  return { ...base, state: 'working', icon: '🔄', text: active?.text ?? 'working' }
}

const ORDER = ['❓', '⚠️', '🔄', '⏸️', '☑️', '✅']
// For file conflicts everything counts that the master has not checked yet: whoever just overwrote a file
// and reported done is the most dangerous case. Only ✅ or hiding takes a session out.
const UNCHECKED = ['❓', '⚠️', '🔄', '⏸️', '☑️']

// Rows are sorted by urgency: if they do not all fit the band, the least important go into a summary row.
function bandRows(rows: BandRow[], room: number) {
  if (rows.length <= room) return { visible: rows, rest: '' }
  const visible = rows.slice(0, Math.max(room - 1, 0))
  const left = rows.slice(visible.length)
  const icons = ORDER.filter(z => left.some(s => s.icon === z)).map(z => `${z}${left.filter(s => s.icon === z).length}`)
  return { visible, rest: `… ${visible.length ? 'and ' : ''}${left.length} more: ${icons.join(' ')}` }
}

function conflictsFrom(sessions: { name: string; paths: string[] }[]): BandConflict[] {
  const who = new Map<string, string[]>()
  for (const session of sessions) {
    for (const path of session.paths) who.set(path, [...(who.get(path) ?? []), session.name])
  }
  return [...who.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([path, names]) => ({ file: path.split('/').pop() ?? path, sessions: names }))
    .sort((a, b) => a.file.localeCompare(b.file))
}

async function jsonOrNothing<T>($: EngineInterface, path: string) {
  try {
    if (!(await $.fs.exists(path))) return undefined
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    // Half-written or broken: next time.
    return undefined
  }
}

// Takes the 5-hour limit from the get_usage answer; anything else means: show nothing.
function fiveHours(answer: { content: unknown[]; isError: boolean }) {
  if (answer.isError) return undefined
  const block = answer.content.find(c => (c as { type?: string }).type === 'text') as { text?: string } | undefined
  const plan = (JSON.parse(block?.text ?? '{}') as { plan?: { status?: string; windows?: { label?: string; percentUsed?: unknown }[] } }).plan
  if (plan?.status !== 'ok') return undefined
  const value = plan.windows?.find(w => /5.?hour/i.test(w.label ?? ''))?.percentUsed
  return typeof value === 'number' ? Math.round(value) : undefined
}

// At most once per minute and independent of the tick: a hanging query must not stop the band.
async function fetchLimit($: EngineInterface, tick: Tick, now: number) {
  if (tick.limitFetched !== undefined && now - tick.limitFetched < MINUTE) return
  tick.limitFetched = now
  try {
    tick.limit = fiveHours(await $.mcp.call('ccd_session_mgmt', 'get_usage', {}))
  } catch {
    tick.limit = undefined
  }
}

async function refreshBand($: EngineInterface, tick: Tick, code: string) {
  try {
    const home = await $.env.get('HOME')
    const folder = `${home}${FOLDER}`
    const now = await $.clock.now()
    void fetchLimit($, tick, now)
    const checked = (await jsonOrNothing<Record<string, number>>($, `${home}${CHECKED}/${code}.json`)) ?? {}
    const rows: BandRow[] = []
    const unchecked: { name: string; paths: string[] }[] = []
    let ownStep = ''
    if (await $.fs.exists(folder)) {
      for (const file of await $.fs.list(folder)) {
        if (!file.name.startsWith(`${code}-`) || !file.name.endsWith('.json') || now - file.mtimeMs > READ_PERIOD) continue
        const status = await jsonOrNothing<Status>($, `${folder}/${file.name}`)
        if (!status) continue
        if (status.isMaster) {
          if (status.state === 'working') ownStep = status.steps?.find(s => s.status === 'in_progress')?.text ?? ''
          continue
        }
        const sessionId = file.name.slice(code.length + 1, -'.json'.length)
        const row = rowFrom(status, now, checked[sessionId])
        if (!row) continue
        const extra = await jsonOrNothing<Extra>($, `${home}${EXTRA}/${file.name}`)
        rows.push(row)
        if (UNCHECKED.includes(row.icon) && Array.isArray(extra?.paths)) unchecked.push({ name: status.name, paths: extra.paths })
      }
    }
    rows.sort((a, b) => ORDER.indexOf(a.icon) - ORDER.indexOf(b.icon) || a.name.localeCompare(b.name))
    const master = (await $.store.get(`master:${code}`)) as Master | undefined
    const open = stillOpen(await readOpen($, code)).length
    const conflicts = conflictsFrom(unchecked)
    const next: BandState = {
      ownStep,
      rows,
      open,
      ...(master?.project ? { project: master.project } : {}),
      ...(tick.limit !== undefined ? { limit: tick.limit } : {}),
      ...(conflicts.length ? { conflicts } : {}),
    }
    const old = await read($, band)
    if (JSON.stringify(old) !== JSON.stringify(next)) await update($, band, () => next)
  } catch {
    // The band must never disturb Maestro; next tick it tries again.
  }
}

// Holds the one tick that rereads the master's band.
type Tick = { clock?: { cancel: () => void }; limit?: number; limitFetched?: number }

async function startBand($: EngineInterface, tick: Tick, code: string) {
  tick.clock?.cancel()
  await refreshBand($, tick, code)
  tick.clock = $.clock.every(3000, () => {
    void refreshBand($, tick, code)
  })
}

// Writes the status of this session if it belongs to a Maestro. Other sessions write nothing.
async function report($: EngineInterface, own: Own) {
  try {
    const sessionId = await $.session.id()
    const master = await myMaster($, sessionId)
    const role = (await $.store.get(`role:${sessionId}`)) as Role | undefined
    const code = master?.code ?? role?.code
    if (!code) return

    const now = await $.clock.now()
    own.reported = now
    const status: Status = {
      code,
      name: master ? 'Maestro' : (role?.name ?? 'Session'),
      isMaster: Boolean(master),
      state: own.state,
      steps: own.steps,
      note: own.note,
      last: now,
      loaded: own.loaded.map(g => g.skill),
      assigned: own.assigned,
      blocked: own.blocked,
    }
    const home = await $.env.get('HOME')
    await $.fs.write(`${home}${FOLDER}/${code}-${sessionId}.json`, JSON.stringify(status))

    if (own.hostId === undefined) own.hostId = (await readHostId($)) ?? ''
    const extra: Extra = { paths: own.paths, ...(own.hostId ? { hostId: own.hostId } : {}) }
    const text = JSON.stringify(extra)
    if (text !== own.extraWritten) {
      await $.fs.write(`${home}${EXTRA}/${code}-${sessionId}.json`, text)
      own.extraWritten = text
    }
  } catch {
    // Reporting must never hold up the work.
  }
}

// Looks for the entry this session left under its former id: first by the host id in the entry;
// older entries have none and are recognized by their extra file. A foreign host id never counts.
async function formerEntry($: EngineInterface, hostId: string) {
  const home = await $.env.get('HOME')
  const masters = await allMasters($)
  const roles: { id: string; role: Role }[] = []
  for (const k of await $.store.keys()) {
    if (!k.startsWith('role:')) continue
    const role = (await $.store.get(k)) as Role
    if (role && typeof role === 'object' && masters.some(m => m.code === role.code)) roles.push({ id: k.slice('role:'.length), role })
  }
  const matches = async (code: string, id: string) =>
    (await jsonOrNothing<Extra>($, `${home}${EXTRA}/${code}-${id}.json`))?.hostId === hostId

  const direct = masters.find(m => m.hostId === hostId)
  if (direct) return { master: direct }
  const directRole = roles.find(r => r.role.hostId === hostId)
  if (directRole) return directRole
  for (const m of masters) if (!m.hostId && (await matches(m.code, m.sessionId))) return { master: m }
  for (const r of roles) if (!r.role.hostId && (await matches(r.role.code, r.id))) return r
  return undefined
}

// Takes over status, extra, check and log of the old id. The old files stay behind as `ended` and empty:
// `$.fs` cannot delete anything, and this way the session does not appear twice in the band.
async function move($: EngineInterface, code: string, oldId: string, newId: string) {
  const home = await $.env.get('HOME')
  const statusOld = `${home}${FOLDER}/${code}-${oldId}.json`
  const statusNew = `${home}${FOLDER}/${code}-${newId}.json`
  const status = await jsonOrNothing<Status>($, statusOld)
  if (status) {
    // A settings hook may already have written a list under the new id; that one is newer.
    if (!(await jsonOrNothing<Status>($, statusNew))?.steps?.length) await $.fs.write(statusNew, JSON.stringify(status))
    await $.fs.write(statusOld, JSON.stringify({ ...status, state: 'ended' }))
  }

  const extraOld = `${home}${EXTRA}/${code}-${oldId}.json`
  const extra = await jsonOrNothing<Extra>($, extraOld)
  if (extra) {
    await $.fs.write(`${home}${EXTRA}/${code}-${newId}.json`, JSON.stringify(extra))
    await $.fs.write(extraOld, JSON.stringify({ paths: [] }))
  }

  const checkPath = `${home}${CHECKED}/${code}.json`
  const checked = await jsonOrNothing<Record<string, number>>($, checkPath)
  if (checked?.[oldId] !== undefined) {
    checked[newId] = checked[oldId]
    delete checked[oldId]
    await $.fs.write(checkPath, JSON.stringify(checked))
  }

  await moveUsage($, oldId, newId)
}

// Recognizes this session by its host id when its session id has no entry any more, and moves everything
// to the new id. After that it carries on as if nothing happened. Without a host id nothing happens.
async function recognize($: EngineInterface, sessionId: string) {
  try {
    const hostId = await readHostId($)
    if (!hostId) return undefined
    const master = await myMaster($, sessionId)
    if (master) {
      if (master.hostId !== hostId) await $.store.set(`master:${master.code}`, { ...master, hostId } satisfies Master)
      return undefined
    }
    const role = (await $.store.get(`role:${sessionId}`)) as Role | undefined
    if (role) {
      if (role.hostId !== hostId) await $.store.set(`role:${sessionId}`, { ...role, hostId } satisfies Role)
      return undefined
    }

    const former = await formerEntry($, hostId)
    if (!former) return undefined
    if ('master' in former && former.master) {
      await move($, former.master.code, former.master.sessionId, sessionId)
      const next: Master = { ...former.master, sessionId, hostId }
      await $.store.set(`master:${next.code}`, next)
      return next
    }
    if ('role' in former && former.role) {
      await move($, former.role.code, former.id, sessionId)
      await $.store.set(`role:${sessionId}`, { ...former.role, hostId } satisfies Role)
      await $.store.delete(`role:${former.id}`)
    }
    return undefined
  } catch {
    // Then the session stays unrecognized but works undisturbed.
    return undefined
  }
}

// Picks up the session's own status after a restart or reload. The session id is in the file name:
// a new session (also after /clear) finds nothing. Whatever was running is not running any more.
async function restore($: EngineInterface, own: Own, sessionId: string) {
  own.restoredFor = sessionId
  try {
    const usage = await readUsage($, sessionId).catch(() => undefined)
    if (usage) {
      if (Array.isArray(usage.loaded)) own.loaded = usage.loaded
      if (Array.isArray(usage.assigned)) own.assigned = usage.assigned
      if (typeof usage.task === 'string') own.task = usage.task
    }

    const master = await myMaster($, sessionId)
    const role = (await $.store.get(`role:${sessionId}`)) as Role | undefined
    const code = master?.code ?? role?.code
    if (!code) return
    const home = await $.env.get('HOME')
    const status = await jsonOrNothing<Status>($, `${home}${FOLDER}/${code}-${sessionId}.json`)
    const extra = await jsonOrNothing<Extra>($, `${home}${EXTRA}/${code}-${sessionId}.json`)
    if (Array.isArray(extra?.paths)) own.paths = extra.paths
    if (!status) return

    if (Array.isArray(status.steps)) own.steps = status.steps
    if (typeof status.note === 'string') own.note = status.note
    if (own.loaded.length === 0 && Array.isArray(status.loaded)) {
      own.loaded = status.loaded.map(skill => ({ skill, time: status.last }))
    }
    if (own.assigned.length === 0 && Array.isArray(status.assigned)) own.assigned = status.assigned
    own.blocked = status.blocked === true
    own.state = own.blocked ? 'waiting' : 'done'
    // Do not write it unchanged: `last` would then no longer be the time of the last report, and ✅ would fall back to ☑️.
    if (status.state !== own.state) await report($, own)
  } catch {
    // Then the session simply starts empty.
  }
}

// Sets ✅ for the current statuses with this name. One file per master; apart from it only `move` changes it.
async function setChecked($: EngineInterface, tick: Tick, code: string, name: string) {
  const home = await $.env.get('HOME')
  const folder = `${home}${FOLDER}`
  const now = await $.clock.now()
  const path = `${home}${CHECKED}/${code}.json`
  const checked = (await jsonOrNothing<Record<string, number>>($, path)) ?? {}
  const names: string[] = []
  const hits: string[] = []
  let notYet: BandRow | undefined
  for (const file of (await $.fs.exists(folder)) ? await $.fs.list(folder) : []) {
    if (!file.name.startsWith(`${code}-`) || !file.name.endsWith('.json') || now - file.mtimeMs > READ_PERIOD) continue
    const status = await jsonOrNothing<Status>($, `${folder}/${file.name}`)
    if (!status || status.isMaster) continue
    const row = rowFrom(status, now)
    if (!row) continue
    names.push(status.name)
    if (status.name !== name) continue
    if (row.icon === '☑️') hits.push(file.name.slice(code.length + 1, -'.json'.length))
    else notYet = row
  }
  if (hits.length === 0) {
    if (notYet) return `${name} has not reported done yet (${notYet.icon} ${notYet.text}); nothing changed.`
    return `No session "${name}" has reported done. In the band: ${names.join(', ') || 'none'}.`
  }
  for (const sessionId of hits) checked[sessionId] = now
  for (const [id, time] of Object.entries(checked)) if (now - time > READ_PERIOD) delete checked[id]
  await $.fs.write(path, JSON.stringify(checked))
  await refreshBand($, tick, code)
  return `${name} is checked (✅) and leaves the band after 30 minutes.`
}

// Summary of the open items for a message; the reminder to catch up applies exactly once.
async function openForMessage($: EngineInterface, code: string) {
  const file = await readOpen($, code)
  const context = openContext(file, code)
  if (file.remind.length > 0 && file.broken === undefined) await writeOpen($, code, { ...file, remind: [] })
  return context
}

// Checks at the end of a master round whether the answer mentions something open. Never adds anything itself.
async function keywordCheck($: EngineInterface, code: string, answer: string) {
  const passage = openSigns(answer)
  if (!passage) return
  const file = await readOpen($, code)
  addReminder(file, passage)
  await writeOpen($, code, file)
}

const changedPath = (tool: string, input: Record<string, unknown>) => {
  const path = tool === 'Write' || tool === 'Edit' ? input.file_path : tool === 'NotebookEdit' ? input.notebook_path : undefined
  return typeof path === 'string' && path.startsWith('/') ? path : undefined
}

// Remembers which file this session changed. A denied call changed nothing.
async function rememberPath($: EngineInterface, own: Own, tool: string, input: Record<string, unknown>, answer: unknown) {
  const path = changedPath(tool, input)
  const result = answer as { deny?: unknown; isError?: unknown } | undefined
  if (!path || result?.deny || result?.isError || own.paths.includes(path)) return
  own.paths = [...own.paths, path].slice(-PATHS_MAX)
  await report($, own)
}

// Writes the skill log of this session. Sessions without a Maestro only count if they loaded a skill.
async function log($: EngineInterface, own: Own) {
  try {
    const sessionId = await $.session.id()
    const master = await myMaster($, sessionId)
    const role = (await $.store.get(`role:${sessionId}`)) as Role | undefined
    const code = master?.code ?? role?.code ?? null
    if (!code && own.loaded.length === 0) return

    const unfinished = own.steps.some(s => s.status !== 'completed')
    const result: Usage['result'] = own.state === 'working' ? 'running' : unfinished ? 'paused' : 'done'
    await writeUsage($, {
      sessionId,
      code,
      name: master ? 'Maestro' : (role?.name ?? null),
      task: own.task,
      assigned: own.assigned,
      loaded: own.loaded,
      result,
      last: await $.clock.now(),
    })
  } catch {
    // The log must never hold up the work.
  }
}

// Registers the mod's tools.
async function registerTools($: EngineInterface) {
  await $.tool.register({
    name: 'master_start',
    description:
      'Makes this session a Maestro master session with its own code; other Maestros stay untouched. Only call it when the maestro skill says so.',
  })
  await $.tool.register({
    name: 'master_end',
    description:
      'Ends the Maestro of this session: its worker sessions then belong to no Maestro. Only call it when the user wants to end Maestro.',
  })
  await $.tool.register({
    name: 'status',
    description:
      'Maestro: says whether this session is a master (with code and task marker) or a worker session, and lists the worker sessions of this master.',
  })

  await $.tool.register({
    name: 'master_name',
    description:
      'Maestro: names this master session after the overall project (title "🎼 <project>", band header). Master only.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'Name of the overall project, at most 40 characters' } },
      required: ['project'],
    },
  })
  await $.tool.register({
    name: 'skills_status',
    description:
      'Maestro: lists all skills with usage and success, tasks without a skill, open notes and cleanup candidates. Call it before assigning skills.',
  })
  await $.tool.register({
    name: 'skill_note',
    description:
      "Maestro: records what was missing or wrong in a skill, from a session's feedback or a correction by the user. Does not change the skill.",
    inputSchema: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Name of the skill' },
        kind: { type: 'string', enum: ['correction', 'error', 'gap'] },
        text: { type: 'string', description: 'One sentence: what was missing or wrong' },
      },
      required: ['skill', 'kind', 'text'],
    },
  })
  await $.tool.register({
    name: 'skills_hide',
    description:
      'Maestro: builds the command the user can run to hide rarely used skills themselves. Changes nothing and runs nothing.',
    inputSchema: {
      type: 'object',
      properties: { skills: { type: 'array', items: { type: 'string' } } },
      required: ['skills'],
    },
  })
  await $.tool.register({
    name: 'open_add',
    description:
      'Maestro: records an open item from the chat so it does not get lost: own suggestion, unanswered question, something put off, open question from a final report. Master only.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The item in one sentence, understandable without the chat' },
        kind: { type: 'string', enum: ['idea', 'question', 'task', 'decision'] },
        source: { type: 'string', description: '"chat" or the name of the session whose report the item came from' },
      },
      required: ['text', 'kind'],
    },
  })
  await $.tool.register({
    name: 'open_close',
    description:
      "Maestro: closes an open item. Only with evidence (done) or on the user's word (dropped). Master only.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id of the item, for example p3' },
        status: { type: 'string', enum: ['done', 'dropped'], description: 'Default: done' },
        reason: { type: 'string', description: "The evidence (file, commit, result) or the user's words" },
      },
      required: ['id', 'reason'],
    },
  })
  await $.tool.register({
    name: 'open_list',
    description: 'Maestro: lists the open items of this master; with all: true also the closed ones with their reason. Master only.',
    inputSchema: { type: 'object', properties: { all: { type: 'boolean' } } },
  })
  await $.tool.register({
    name: 'session_checked',
    description:
      'Maestro: marks a session that reported done (☑️) as checked (✅). Only call it after you looked at its result yourself. Master only.',
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string', description: 'Name of the session as the band shows it' } },
      required: ['session'],
    },
  })
  await $.tool.register({
    name: 'skill_change',
    description:
      "Maestro: records that a skill was changed on the user's word (skill, date, backup folder), so skills_status can compare the effect. Changes nothing itself.",
    inputSchema: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Name of the skill' },
        backup: { type: 'string', description: 'Folder with the state before the change' },
        date: { type: 'string', description: 'ISO date of the change; default: now' },
      },
      required: ['skill', 'backup'],
    },
  })
}

export const register: Register = on => {
  // Session id of the master before a /clear. Afterwards the process carries on under a new id.
  let beforeClear: string | undefined
  // Has the master loaded the maestro skill in this process, or been reminded of it once?
  // `own.loaded` is no good for this: after a restart it comes back from the old status.
  let skillReminded = false
  const tick: Tick = {}
  const own = newOwn()

  on('session.start', async ($, e, next) => {
    try {
      await registerTools($)
    } catch {
      // Without tools the session stays an ordinary session.
    }

    const sessionId = await $.session.id()
    await recognize($, sessionId)
    await restore($, own, sessionId)
    const master = await myMaster($, sessionId)
    if (master) {
      $.ui.status('Maestro · Master')
      await startBand($, tick, master.code)
    }

    return next(e)
  })

  on('tool.call', { tool: TOOL('master_start') }, async $ => {
    const sessionId = await $.session.id()
    // Resumed under a new id: the same Maestro, no new code.
    await recognize($, sessionId)
    const existing = await myMaster($, sessionId)
    const code = existing?.code ?? sessionId.slice(0, 8)
    const hostId = await readHostId($)
    await $.store.set(`master:${code}`, { code, sessionId, since: existing?.since ?? new Date().toISOString(), ...(existing?.project ? { project: existing.project } : {}), ...(hostId ? { hostId } : {}) } satisfies Master)
    await $.store.delete(`role:${sessionId}`)
    $.ui.status('Maestro · Master')
    await startBand($, tick, code)

    return {
      result: `This session is ${existing ? 'still' : 'now'} a Maestro master. Code: ${code}. Task marker (exactly like this in every task and every follow-up message): ${marker(code)}. Handoff file: ${handoff(code)}. Open items: ${openFile(code)}. Other Maestros in other sessions carry on independently.`,
    }
  })

  on('tool.call', { tool: TOOL('master_end') }, async $ => {
    const sessionId = await $.session.id()
    const master = await myMaster($, sessionId)
    if (!master) return { result: 'This session is not a Maestro master.' }

    await $.store.delete(`master:${master.code}`)
    let freed = 0
    for (const k of await $.store.keys()) {
      if (!k.startsWith('role:')) continue
      const role = (await $.store.get(k)) as Role
      if (role.code !== master.code) continue
      await $.store.delete(k)
      freed++
    }
    $.ui.status(undefined)
    tick.clock?.cancel()
    tick.clock = undefined
    await update($, band, () => null)

    const open = stillOpen(await readOpen($, master.code).catch(() => ({ items: [], remind: [] }))).length
    const rest = open ? ` ${open} open items stay in ${openFile(master.code)}.` : ''
    return { result: `Maestro ${master.code} ended; ${freed} worker session(s) released.${rest}` }
  })

  on('tool.call', { tool: TOOL('status') }, async $ => {
    const sessionId = await $.session.id()
    const master = await myMaster($, sessionId)
    const role = (await $.store.get(`role:${sessionId}`)) as Role | undefined
    const open = master ? stillOpen(await readOpen($, master.code).catch(() => ({ items: [], remind: [] }))).length : 0
    const workerSessions = []
    if (master) {
      for (const k of await $.store.keys()) {
        if (!k.startsWith('role:')) continue
        const r = (await $.store.get(k)) as Role
        if (r.code === master.code) workerSessions.push({ sessionId: k.slice('role:'.length), name: r.name })
      }
    }

    return {
      result: JSON.stringify({
        isMaster: Boolean(master),
        code: master?.code ?? null,
        marker: master ? marker(master.code) : null,
        workerOf: role ?? null,
        workerSessions,
        openItems: open,
      }),
    }
  })

  on('tool.call', { tool: TOOL('master_name') }, async ($, e) => {
    const project = projectName((e as unknown as { project?: unknown }).project)
    const master = await myMaster($, await $.session.id())
    if (!master) return { result: 'This session is not a Maestro master; nothing named.' }
    if (!project) return { result: 'No project name given; nothing named.' }
    await $.store.set(`master:${master.code}`, { ...master, project } satisfies Master)
    await refreshBand($, tick, master.code)

    const title = `🎼 ${project}`
    try {
      const answer = await $.mcp.call('ccd_session_mgmt', 'set_session_title', { session_id: 'self', title })
      if (!answer.isError) return { result: `Title set: ${title}` }
    } catch {
      // The server is not reachable for the mod: the master sets the title itself.
    }

    return { result: `Band named. Title not set yet: call set_session_title with session_id "self" and title "${title}" yourself.` }
  })

  on('tool.call', { tool: TOOL('open_add') }, async ($, e) => {
    const master = await myMaster($, await $.session.id())
    if (!master) return { result: 'Only the master keeps open items; nothing added.' }
    const file = await readOpen($, master.code)
    const result = addItem(file, e as unknown as Record<string, unknown>, await $.clock.now())
    if ('error' in result) return { result: result.error }
    if (!result.existed) await writeOpen($, master.code, file)
    own.openAdded = true
    await refreshBand($, tick, master.code)
    const state = `${result.item.id}; open: ${stillOpen(file).length}.`
    const aside = file.broken === undefined ? '' : ' The old file was not readable and lies next to it as a .broken file.'
    return { result: `${result.existed ? 'Already recorded as' : 'Recorded as'} ${state}${aside}` }
  })

  on('tool.call', { tool: TOOL('open_close') }, async ($, e) => {
    const master = await myMaster($, await $.session.id())
    if (!master) return { result: 'Only the master keeps open items; nothing closed.' }
    const file = await readOpen($, master.code)
    const result = closeItem(file, e as unknown as Record<string, unknown>, await $.clock.now())
    if ('error' in result) return { result: result.error }
    await writeOpen($, master.code, file)
    await refreshBand($, tick, master.code)
    return { result: `${result.item.id} is ${result.item.status}; open: ${stillOpen(file).length}.` }
  })

  on('tool.call', { tool: TOOL('open_list') }, async ($, e) => {
    const master = await myMaster($, await $.session.id())
    if (!master) return { result: 'Only the master keeps open items.' }
    const file = await readOpen($, master.code)
    const open = stillOpen(file)
    const all = (e as unknown as { all?: unknown }).all === true
    return {
      result: JSON.stringify({
        file: openFile(master.code),
        openCount: open.length,
        items: all ? file.items : open,
        ...(file.broken === undefined ? {} : { warning: 'The file is not readable; the next open_add puts it aside.' }),
      }),
    }
  })

  on('tool.call', { tool: TOOL('session_checked') }, async ($, e) => {
    const master = await myMaster($, await $.session.id())
    if (!master) return { result: 'Only the master checks sessions; nothing changed.' }
    const name = String((e as unknown as { session?: unknown }).session ?? '').trim()
    if (!name) return { result: 'No session name given; nothing changed.' }
    return { result: await setChecked($, tick, master.code, name) }
  })

  on('tool.call', { tool: TOOL('skill_change') }, async ($, e) => {
    const input = e as unknown as { skill?: unknown; backup?: unknown; date?: unknown }
    const skill = String(input.skill ?? '')
    const backup = String(input.backup ?? '').trim()
    if (!/^[\w:.-]+$/.test(skill) || !backup) {
      return { result: 'Nothing recorded: a skill name (only letters, digits, : . _ -) and a backup folder are needed.' }
    }
    const home = await $.env.get('HOME')
    if (!(await $.fs.exists(backup.replace(/^~(?=\/)/, home ?? '~')))) {
      return { result: `Nothing recorded: the backup folder ${backup} does not exist. Without a backup the change cannot be rolled back.` }
    }
    const date = Date.parse(String(input.date ?? ''))
    await writeChange($, { skill, backup, time: Number.isNaN(date) ? await $.clock.now() : date })

    return { result: `Change to ${skill} recorded; skills_status compares before and after from now on.` }
  })

  on('tool.call', { tool: TOOL('skills_status') }, async $ => ({ result: JSON.stringify(await skillsStatus($)) }))

  on('tool.call', { tool: TOOL('skill_note') }, async ($, e) => {
    const input = e as unknown as { skill?: unknown; kind?: unknown; text?: unknown }
    if (!/^[\w:.-]+$/.test(String(input.skill ?? '')) || !String(input.text ?? '').trim()) {
      return { result: 'No note recorded: a skill name (only letters, digits, : . _ -) and a text are needed.' }
    }
    await writeNote($, {
      skill: String(input.skill ?? ''),
      kind: String(input.kind ?? 'error'),
      text: String(input.text ?? '').slice(0, 300),
      time: await $.clock.now(),
    })

    return { result: 'Note recorded; the skill stays unchanged.' }
  })

  on('tool.call', { tool: TOOL('skills_hide') }, async (_, e) => {
    return { result: JSON.stringify(hideCommand((e as unknown as { skills?: unknown }).skills)) }
  })

  on('skill.prompt', async ($, e, next) => {
    const answer = await next(e)
    if (e.skill === 'maestro' || e.skill.endsWith(':maestro')) skillReminded = true
    if (!own.loaded.some(g => g.skill === e.skill)) {
      own.loaded = [...own.loaded, { skill: e.skill, time: await $.clock.now() }]
      await report($, own)
      await log($, own)
    }

    return answer
  })

  on('session.end', async ($, e, next) => {
    own.state = 'ended'
    own.waitingForApproval = false
    await report($, own)
    await log($, own)
    try {
      if (e.reason === 'clear') {
        skillReminded = false
        if (await myMaster($, e.sessionId)) beforeClear = e.sessionId
        // A cleared worker session only belongs again with its next task; the host id must not bring
        // back its old status. Only after reporting: without a role it would write nothing.
        else await $.store.delete(`role:${e.sessionId}`)
      }
    } catch {
      // Then nobody reminds of the handoff after clearing; the work comes first.
    }
    Object.assign(own, newOwn(), { hostId: own.hostId, restoredFor: undefined, extraWritten: undefined })

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // A malfunction of the mod must never hold up the message: everything here, then `next` in any case.
    const context: string[] = []
    try {
      const sessionId = await $.session.id()
      own.waitingForApproval = false

      // Master after /clear: register the new session id under the same code and remind of the handoff.
      let afterClear: Master | undefined
      if (beforeClear && beforeClear !== sessionId) {
        afterClear = await myMaster($, beforeClear)
        beforeClear = undefined
      }
      if (afterClear) {
        await $.store.set(`master:${afterClear.code}`, { ...afterClear, sessionId } satisfies Master)
        $.ui.status('Maestro · Master')
        own.restoredFor = sessionId
        own.state = 'working'
        skillReminded = true
        await report($, own)
        await startBand($, tick, afterClear.code)
        context.push(
          `You are still the Maestro master session with code ${afterClear.code} (task marker ${marker(afterClear.code)}); the chat was cleared after a handoff. First load the maestro skill and read ${handoff(afterClear.code)}, then handle this message.`,
          ...(await openForMessage($, afterClear.code)),
        )
      } else {
        // Resumed without session.start: the same session picks up its status again.
        if (own.restoredFor !== sessionId) {
          const recognized = await recognize($, sessionId)
          await restore($, own, sessionId)
          if (recognized) {
            $.ui.status('Maestro · Master')
            await startBand($, tick, recognized.code)
          }
        }

        // A master's task makes this session its worker session; a master never becomes one.
        // What the user types in a worker session always stays in that session.
        own.state = 'working'
        own.blocked = false
        own.note = ''
        const master = await myMaster($, sessionId)
        if (master) {
          await report($, own)
          if (!e.isMeta && !skillReminded) {
            skillReminded = true
            context.push(
              `You are the Maestro master session with code ${master.code} (task marker ${marker(master.code)}). If the maestro skill is not loaded in this chat yet, load it now, before you handle this message.`,
            )
          }
          if (!e.isMeta) context.push(...(await openForMessage($, master.code)))
        } else if (!e.text.includes(MARK)) {
          await report($, own)
        } else {
          const hit = NAME_IN_MARKER.exec(e.text)
          const name = hit?.[1]?.trim()
          const all = await allMasters($)
          // Without a code, only assign when there is exactly one Maestro.
          const code = hit?.[2] ?? (all.length === 1 ? all[0].code : undefined)
          if (name && code && all.some(m => m.code === code)) {
            const hostId = await readHostId($)
            await $.store.set(`role:${sessionId}`, { name, code, ...(hostId ? { hostId } : {}) } satisfies Role)
            $.ui.status('Maestro · Worker')
            const parsed = readTask(e.text)
            // A new task starts afresh: old files are no conflict with what is running now.
            if (parsed.task && parsed.task !== own.task) own.paths = []
            own.task = parsed.task || own.task
            if (parsed.assigned) own.assigned = [...new Set(parsed.assigned)]
          }
          await report($, own)
          await log($, own)
        }
      }
    } catch {
      // The message goes through even without status and context.
    }

    return next(context.length ? { ...e, context: [...(e.context ?? []), ...context] } : e)
  })

  // Is the session waiting for an approval card? The app only draws the card after this chain.
  // A settings hook may already have answered the question; then nobody waits.
  on('classic.PermissionRequest', async ($, e, next) => {
    const answer = await next(e)
    if (!e.agent_id && !answer.decision) {
      own.waitingForApproval = true
      own.state = 'waiting'
      own.blocked = false
      own.note = 'waiting for your approval'
      await report($, own)
    }

    return answer
  })

  // The mod sets the marker itself: a master that did not load the skill after a restart forgets it
  // otherwise, and its worker sessions are missing from the band.
  on('tool.call', { tool: START_SESSION }, async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const master = await myMaster($, await $.session.id())
    if (!master || typeof input.prompt !== 'string') return next(e)
    const name = sessionName(input.name, input.title)
    const withMarker = input.prompt.includes(MARK) ? input.prompt : `${markerFor(name, master.code)} ${input.prompt}`
    const answer = await next({ ...e, prompt: withMarker } as typeof e)
    await rememberTarget($, master.code, name, answer)
    return answer
  })

  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    if (typeof input.message !== 'string' || input.message.includes(MARK)) return next(e)
    const master = await myMaster($, await $.session.id())
    if (!master) return next(e)
    const name = await targetName($, master.code, input.to)
    if (!name) return next(e)
    return next({ ...e, message: `${markerFor(name, master.code)} ${input.message}` } as typeof e)
  })

  // Record the task list, questions and signs of life of this session.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    if (e.agentId) {
      // A subagent changes this session's files too.
      const fromAgent = await next(e)
      await rememberPath($, own, tool, input, fromAgent)
      return fromAgent
    }

    if (tool === 'AskUserQuestion') {
      own.state = 'waiting'
      own.note = 'has a question for you'
      await report($, own)
      const answer = await next(e)
      own.state = 'working'
      own.note = ''
      await report($, own)
      return answer
    }

    const now = await $.clock.now()
    // A parallel call does not end waiting for a card.
    if (!own.waitingForApproval && (own.state !== 'working' || now - own.reported > HEARTBEAT)) {
      own.state = 'working'
      await report($, own)
    }

    const answer = await next(e)

    // The call came back, so the card is answered.
    if (own.waitingForApproval) {
      own.waitingForApproval = false
      own.state = 'working'
      own.note = ''
      await report($, own)
    }
    await rememberPath($, own, tool, input, answer)

    if (tool.endsWith('__update_plan')) {
      own.steps = applyPlan(own.steps, input)
      await report($, own)
    } else if (tool.endsWith('__wrap_up')) {
      own.steps = own.steps.map(s => ({ ...s, status: 'completed' }))
      own.blocked = input.blocked === true
      const question = typeof input.ask === 'string' ? input.ask : ''
      const recap = typeof input.recap === 'string' ? input.recap : ''
      own.note = brief(own.blocked && question ? question : recap)
      await report($, own)
    }

    return answer
  })

  on('turn.complete', async ($, e, next) => {
    if (!(e as { agentId?: string }).agentId) {
      own.waitingForApproval = false
      own.state = own.blocked ? 'waiting' : 'done'
      await report($, own)
      await log($, own)
      try {
        const master = await myMaster($, await $.session.id())
        if (master && e.reason === 'answer' && !own.openAdded) await keywordCheck($, master.code, e.answer)
      } catch {
        // The keyword check is a help, not a condition.
      }
      own.openAdded = false
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const state = await read($, band)
    if (state === null || e.props.hasSurvey) return next(e)

    // Display only: answering, stopping and steering go through Maestro's text field.
    const { Box, Text } = $.ui.resolve(e)
    const width = e.props.bodyColumns
    const withBar = width >= 56
    const show = (percent: number | null | undefined) =>
      typeof percent === 'number' ? `${withBar ? `${bar(percent)} ` : ''}${percent} %` : ''

    // Header: important things first, the text last. That way a narrow window cuts the text first.
    const ownText = e.props.isWorking ? state.ownStep || 'working' : 'ready'
    const count = (z: BandRow['icon']) => state.rows.filter(s => s.icon === z).length
    const counter = ORDER.filter(z => count(z) > 0).map(z => `${z}${count(z)}`).join(' ')
    const withList = state.rows.filter(z => typeof z.percent === 'number')
    const total = withList.length
      ? Math.round(withList.reduce((sum, z) => sum + (z.percent ?? 0), 0) / withList.length)
      : null
    const open = state.open ?? 0
    const limit = state.limit
    const limitHigh = limit !== undefined && limit >= LIMIT_WARNING
    const limitWarning = limitHigh ? `⚠️ 5h ${limit} %` : ''
    const left = [
      `🎼 ${state.project || 'Maestro'}`,
      open > 0 ? `📌 ${open}` : '',
      limitWarning,
      counter,
      show(total),
      limit !== undefined && !limitHigh && width >= 40 ? `5h ${limit} %` : '',
    ].filter(Boolean)
    const textRoom = Math.max(width - left.join('  ').length - 2, 8)

    const conflicts = state.conflicts ?? []
    const conflict = conflicts[0]
    const conflictText = conflict
      ? `${conflict.file}${conflicts.length > 1 ? ` and ${conflicts.length - 1} more` : ''}`
      : ''

    const room = Math.max(Math.min(BAND_MAX_ROWS, e.props.maxRows) - 1 - (conflict ? 1 : 0), 1)
    const { visible, rest } = bandRows(state.rows, room)

    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text bold>{left[0]}</Text>
          {left.slice(1).map(part =>
            part === limitWarning ? <Text bold color="warning">{`  ${part}`}</Text> : `  ${part}`,
          )}
          {`  ${terse(ownText, textRoom)}${state.rows.length === 0 ? ' · no worker session' : ''}`}
        </Text>
        {conflict ? (
          <Text wrap="truncate-end" bold color="warning">
            ⚠️ File conflict {conflict.sessions.join(' + ')}: {conflictText}
          </Text>
        ) : null}
        {visible.map(z => {
          const front = [`${z.icon} ${[z.name, z.skill, show(z.percent)].filter(Boolean).join(' ')}`, z.prefix].filter(Boolean).join(' · ')

          return (
            <Text wrap="truncate-end" dimColor={z.icon === '✅'} bold={z.icon === '❓' || z.icon === '⚠️'}>
              {front} · {terse(z.text, Math.max(width - front.length - 5, 10))}
            </Text>
          )
        })}
        {rest ? <Text wrap="truncate-end" dimColor>{rest}</Text> : null}
      </Box>
    )
  })
}
