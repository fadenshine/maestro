#!/usr/bin/env node
// Copies the data of the old "dirigent" plugin into the new "maestro" layout.
// Reads ~/.claude/dirigent/ and the dirigent store under ~/.claude/plugins/store/, and writes
// ~/.claude/maestro/ and the maestro store. The old folder and the old store are never changed.
// Files that already exist in the new place are left alone, so running it twice is safe.
//
//   node tools/migrate-from-dirigent.mjs            copy everything
//   node tools/migrate-from-dirigent.mjs --dry-run  only show what would be copied
//
// The maestro store file only exists after maestro has run once. If it is missing, the script copies the
// files and says so; start one session with maestro installed and run the script again for the store.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DRY = process.argv.includes('--dry-run')
const HOME = process.env.MIGRATE_HOME || os.homedir()
const OLD = path.join(HOME, '.claude', 'dirigent')
const NEW = path.join(HOME, '.claude', 'maestro')
const STORE = path.join(HOME, '.claude', 'plugins', 'store')

const counts = { converted: 0, copied: 0, skipped: 0, storeKeys: 0 }
const map = (table, value, fallback) => table[value] ?? fallback ?? value
const rename = name => (name === 'Dirigent' ? 'Maestro' : name)

const KIND = { idee: 'idea', frage: 'question', aufgabe: 'task', entscheidung: 'decision' }
const ITEM_STATUS = { offen: 'open', erledigt: 'done', verworfen: 'dropped' }
const STATE = { arbeitet: 'working', wartet: 'waiting', fertig: 'done', beendet: 'ended' }
const RESULT = { laeuft: 'running', fertig: 'done', pausiert: 'paused' }
const NOTE_KIND = { korrektur: 'correction', fehler: 'error', luecke: 'gap' }

const convert = {
  open: d => ({
    items: (d.punkte ?? []).map(p => ({
      id: p.id,
      text: p.text,
      kind: map(KIND, p.art, 'idea'),
      source: p.quelle ?? 'chat',
      time: p.zeit ?? 0,
      status: map(ITEM_STATUS, p.status, 'open'),
      ...(p.grund !== undefined ? { reason: p.grund } : {}),
      ...(p.geschlossen !== undefined ? { closed: p.geschlossen } : {}),
    })),
    remind: d.nachholen ?? [],
  }),
  status: d => ({
    code: d.kennung,
    name: rename(d.name),
    isMaster: d.istMaster,
    state: map(STATE, d.zustand),
    steps: d.schritte ?? [],
    note: d.notiz ?? '',
    last: d.zuletzt,
    ...(d.geladen ? { loaded: d.geladen } : {}),
    ...(d.zugewiesen ? { assigned: d.zugewiesen } : {}),
    ...(d.blockiert !== undefined ? { blocked: d.blockiert } : {}),
  }),
  extra: d => ({ ...(d.hostId ? { hostId: d.hostId } : {}), paths: d.pfade ?? [] }),
  usage: d => ({
    sessionId: d.sessionId,
    code: d.kennung ?? null,
    name: d.name == null ? null : rename(d.name),
    task: d.auftrag ?? '',
    assigned: d.zugewiesen ?? [],
    loaded: (d.geladen ?? []).map(g => ({ skill: g.skill, time: g.zeit })),
    result: map(RESULT, d.ergebnis),
    last: d.zuletzt,
  }),
  note: d => ({ skill: d.skill, kind: map(NOTE_KIND, d.art), text: d.text, time: d.zeit }),
  change: d => ({ skill: d.skill, time: d.zeit, backup: d.sicherung }),
}

function write(target, text, stat) {
  if (fs.existsSync(target)) {
    counts.skipped++
    return false
  }
  if (!DRY) {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, text)
    // The band only reads status files by their modification time; keep it.
    if (stat) fs.utimesSync(target, stat.atime, stat.mtime)
  }
  return true
}

function convertFolder(from, to, fn) {
  const src = path.join(OLD, from)
  if (!fs.existsSync(src)) return
  for (const name of fs.readdirSync(src)) {
    const file = path.join(src, name)
    const stat = fs.statSync(file)
    if (!stat.isFile()) continue
    let text
    let target = path.join(NEW, to, name)
    if (name.endsWith('.json')) {
      try {
        text = JSON.stringify(fn(JSON.parse(fs.readFileSync(file, 'utf8'))))
      } catch {
        // Not readable as JSON: keep the raw content, like the mod does with broken files.
        text = fs.readFileSync(file)
        target = path.join(NEW, to, `${name}.broken-migrate.txt`)
      }
      if (write(target, text, stat)) counts.converted++
    } else {
      target = path.join(NEW, to, name.replace('.defekt-', '.broken-'))
      if (write(target, fs.readFileSync(file), stat)) counts.copied++
    }
  }
}

function copyTree(from, to) {
  if (!fs.existsSync(from)) return
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name)
    const b = path.join(to, entry.name)
    if (entry.isDirectory()) copyTree(a, b)
    else if (entry.isFile() && write(b, fs.readFileSync(a), fs.statSync(a))) counts.copied++
  }
}

function migrateFiles() {
  convertFolder('offen', 'open', convert.open)
  convertFolder('stand', 'status', convert.status)
  convertFolder('zusatz', 'extra', convert.extra)
  convertFolder('geprueft', 'checked', d => d)
  convertFolder('skills/nutzung', 'skills/usage', convert.usage)
  convertFolder('skills/hinweise', 'skills/notes', convert.note)
  convertFolder('skills/aenderungen', 'skills/changes', convert.change)
  copyTree(path.join(OLD, 'vorschlaege'), path.join(NEW, 'proposals'))
  copyTree(path.join(OLD, 'skill-sicherung'), path.join(NEW, 'skill-backup'))

  const known = new Set(['offen', 'stand', 'zusatz', 'geprueft', 'skills', 'vorschlaege', 'skill-sicherung'])
  for (const entry of fs.readdirSync(OLD, { withFileTypes: true })) {
    if (known.has(entry.name)) continue
    const a = path.join(OLD, entry.name)
    const handoff = /^uebergabe-(.+\.md)$/.exec(entry.name)
    if (entry.isFile() && handoff) {
      if (write(path.join(NEW, `handoff-${handoff[1]}`), fs.readFileSync(a), fs.statSync(a))) counts.copied++
    } else if (entry.isDirectory()) {
      copyTree(a, path.join(NEW, 'from-dirigent', entry.name))
    } else if (entry.isFile() && write(path.join(NEW, 'from-dirigent', entry.name), fs.readFileSync(a), fs.statSync(a))) {
      counts.copied++
    }
  }
}

function storeFile(prefix) {
  if (!fs.existsSync(STORE)) return []
  return fs.readdirSync(STORE).filter(n => n.startsWith(`${prefix}_`) && n.endsWith('.json')).map(n => path.join(STORE, n))
}

function migrateStore() {
  const olds = storeFile('dirigent')
  if (olds.length === 0) return 'no dirigent store found'
  const news = storeFile('maestro')
  if (news.length !== 1) {
    return news.length === 0
      ? 'maestro store not found yet: start one session with maestro installed, then run this script again'
      : `several maestro stores found (${news.map(n => path.basename(n)).join(', ')}); store not migrated`
  }
  const target = JSON.parse(fs.readFileSync(news[0], 'utf8'))
  for (const old of olds) {
    const source = JSON.parse(fs.readFileSync(old, 'utf8'))
    for (const [key, v] of Object.entries(source)) {
      let newKey
      let value
      if (key.startsWith('master:') && v && typeof v === 'object') {
        newKey = key
        value = {
          code: v.kennung,
          sessionId: v.sessionId,
          since: v.seit,
          ...(v.projekt ? { project: v.projekt } : {}),
          ...(v.hostId ? { hostId: v.hostId } : {}),
        }
      } else if (key.startsWith('rolle:') && v && typeof v === 'object') {
        newKey = `role:${key.slice('rolle:'.length)}`
        value = { name: v.name, code: v.kennung, ...(v.hostId ? { hostId: v.hostId } : {}) }
      } else if (key.startsWith('ziel:') && v && typeof v === 'object') {
        newKey = `target:${key.slice('ziel:'.length)}`
        value = { name: v.name, code: v.kennung }
      } else continue
      if (newKey in target) continue
      target[newKey] = value
      counts.storeKeys++
    }
  }
  if (!DRY) {
    fs.copyFileSync(news[0], `${news[0]}.before-migrate`)
    fs.writeFileSync(news[0], JSON.stringify(target, null, 2))
  }
  return `store: ${path.basename(news[0])}`
}

if (!fs.existsSync(OLD)) {
  console.log(`Nothing to migrate: ${OLD} does not exist.`)
} else {
  migrateFiles()
  const store = migrateStore()
  console.log(
    `${DRY ? '[dry run] ' : ''}${counts.converted} files converted, ${counts.copied} copied, ${counts.skipped} already there; ` +
      `${counts.storeKeys} store entries; ${store}. Old data in ${OLD} is unchanged.`,
  )
}
