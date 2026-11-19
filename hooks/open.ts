import type { EngineInterface } from 'claude-code'

// Open items of a Maestro: ideas, questions, tasks and decisions from the chat that must not get lost.
// One file per Maestro, no session id in it: it survives /clear and restarts.
// Only the master writes, so read, change, write back in full is enough.
const FOLDER = '/.claude/maestro/open'
const TEXT_MAX = 500
const IN_CONTEXT = 12
const IN_CONTEXT_TEXT = 100
const REMIND_MAX = 3

export const KINDS = ['idea', 'question', 'task', 'decision'] as const
export type Kind = (typeof KINDS)[number]

export type Item = {
  id: string
  text: string
  kind: Kind
  /** `chat` or the name of the session whose final report the item came from. */
  source: string
  time: number
  status: 'open' | 'done' | 'dropped'
  reason?: string
  closed?: number
}

export type OpenFile = {
  items: Item[]
  /** Passages from answers in whose round nothing was added; the next message reminds of them. */
  remind: string[]
  /** The file was not readable. Before the next write its content is put aside. */
  broken?: string
}

export const openFile = (code: string) => `~/.claude/maestro/open/${code}.json`

function readItems(raw: unknown): Item[] {
  if (!Array.isArray(raw)) return []
  const items: Item[] = []
  for (const entry of raw as Partial<Item>[]) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.text !== 'string') continue
    items.push({
      ...entry,
      id: entry.id,
      text: entry.text,
      kind: KINDS.includes(entry.kind as Kind) ? (entry.kind as Kind) : 'idea',
      source: typeof entry.source === 'string' ? entry.source : 'chat',
      time: typeof entry.time === 'number' ? entry.time : 0,
      status: entry.status === 'done' || entry.status === 'dropped' ? entry.status : 'open',
    })
  }
  return items
}

export async function readOpen($: EngineInterface, code: string): Promise<OpenFile> {
  const home = await $.env.get('HOME')
  const path = `${home}${FOLDER}/${code}.json`
  if (!(await $.fs.exists(path))) return { items: [], remind: [] }
  const raw = await $.fs.read(path)
  try {
    const value = JSON.parse(raw) as { items?: unknown; remind?: unknown }
    return {
      items: readItems(value.items),
      remind: Array.isArray(value.remind) ? value.remind.filter(n => typeof n === 'string') : [],
    }
  } catch {
    return { items: [], remind: [], broken: raw }
  }
}

export async function writeOpen($: EngineInterface, code: string, file: OpenFile) {
  const home = await $.env.get('HOME')
  // A broken file may still contain readable items; it is never simply overwritten.
  if (file.broken !== undefined) {
    await $.fs.write(`${home}${FOLDER}/${code}.broken-${await $.clock.now()}.txt`, file.broken)
  }
  await $.fs.write(`${home}${FOLDER}/${code}.json`, JSON.stringify({ items: file.items, remind: file.remind }))
}

export const stillOpen = (file: OpenFile) => file.items.filter(p => p.status === 'open')

const shorten = (text: string, max: number) => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

// Hands out the next number; closed items count too, so an id never appears twice.
function nextId(items: Item[]) {
  const highest = items.reduce((max, p) => Math.max(max, Number(/^p(\d+)$/.exec(p.id)?.[1] ?? 0)), 0)
  return `p${highest + 1}`
}

export function addItem(file: OpenFile, input: { text?: unknown; kind?: unknown; source?: unknown }, time: number) {
  const text = String(input.text ?? '').trim().slice(0, TEXT_MAX)
  if (!text) return { error: 'Nothing added: text is missing.' }
  if (!KINDS.includes(input.kind as Kind)) return { error: `Nothing added: kind must be one of ${KINDS.join(', ')}.` }
  const same = stillOpen(file).find(p => p.text.toLowerCase() === text.toLowerCase())
  if (same) return { item: same, existed: true }
  const source = shorten(String(input.source ?? ''), 40) || 'chat'
  const item: Item = { id: nextId(file.items), text, kind: input.kind as Kind, source, time, status: 'open' }
  file.items.push(item)
  return { item, existed: false }
}

export function closeItem(file: OpenFile, input: { id?: unknown; reason?: unknown; status?: unknown }, time: number) {
  const reason = String(input.reason ?? '').trim().slice(0, 300)
  if (!reason) return { error: 'Nothing closed: reason is missing (evidence for "done" or the user\'s words).' }
  const item = file.items.find(p => p.id === input.id)
  if (!item) return { error: `Nothing closed: there is no item ${String(input.id)}.` }
  if (item.status !== 'open') return { error: `Item ${item.id} is already ${item.status}.` }
  item.status = input.status === 'dropped' ? 'dropped' : 'done'
  item.reason = reason
  item.closed = time
  return { item }
}

// Summary for the context of every message. The user does not see it; the master should.
export function openContext(file: OpenFile, code: string) {
  const parts: string[] = []
  const open = stillOpen(file)
  if (open.length > 0) {
    const lines = open
      .slice(0, IN_CONTEXT)
      .map(p => `- ${p.id} [${p.kind}${p.source === 'chat' ? '' : `, ${p.source}`}] ${shorten(p.text, IN_CONTEXT_TEXT)}`)
    const more = open.length > IN_CONTEXT ? [`- … and ${open.length - IN_CONTEXT} more (open_list)`] : []
    parts.push(
      [
        `Open items of this Maestro (${open.length}, file ${openFile(code)}). State the count in one line at the end of your answer; if the message fits or settles an item, say so.`,
        ...lines,
        ...more,
      ].join('\n'),
    )
  }
  if (file.remind.length > 0) {
    parts.push(
      `Reminder from the mod (only a keyword check): your last answer contained something that sounds like a suggestion, recommendation or open question, and open_add did not run in that round. Check it and use open_add for whatever is really open; ignore the rest. Passages: ${file.remind.map(n => `"${n}"`).join(' · ')}`,
    )
  }
  return parts
}

// German and English keywords: the user may chat in either language.
const SIGNS =
  /\b(vorschlag|vorschläge\w*|vorschlagen|schlage\b.*\bvor|empfehl\w*|später|noch offen|bleibt offen|offene frage\w*|zurückgestellt|zurückstellen|könnten wir|sollten wir|sollen wir|nächste[rn]? schritte?|follow-?up|recommend\w*|suggest\w*|later|still open|open question\w*|next steps?|we could|should we)\b/i

// Finds the first passage that sounds like something open. Only a hint to the master, never an entry:
// code does not count, and neither does the count line (📌), otherwise it would remind of itself.
export function openSigns(answer: string) {
  const text = answer
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .split('\n')
    .filter(line => !line.trim().startsWith('📌') && !line.trim().startsWith('>'))
    .join('\n')
  for (const sentence of text.split(/(?<=[.!?…])\s+|\n+/)) {
    const clean = sentence.trim()
    if (clean && (clean.endsWith('?') || SIGNS.test(clean))) return shorten(clean, 120)
  }
  return null
}

export function addReminder(file: OpenFile, passage: string) {
  if (!file.remind.includes(passage)) file.remind = [...file.remind, passage].slice(-REMIND_MAX)
}
