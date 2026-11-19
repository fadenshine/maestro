import { expect, test } from 'claude-code/testing'

const ID = 'aaaaaaaa-0000-4000-8000-000000000000'
const BAND = {
  plugin: 'maestro',
  component: 'AbovePrompt',
  surface: 'desktop',
  requestId: 'band',
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const
const NOW = 1_800_000_000_000

// `skills` fills the folders of the skill log (`usage`, `notes`); everything else reads from `files`.
type SkillFiles = { usage: Record<string, object>; notes: Record<string, object> }
function world(on: any, files: Record<string, object>, written: Record<string, string> = {}, isMaster: boolean | null = true, skills?: SkillFiles, project?: string, sets?: Record<string, any>) {
  const folder = (path: string) => (path.includes('/skills/usage') ? skills?.usage : path.includes('/skills/notes') ? skills?.notes : undefined) ?? files
  const store: Record<string, unknown> = isMaster === null
    ? {}
    : isMaster
    ? { 'master:aaaaaaaa': { code: 'aaaaaaaa', sessionId: ID, since: 'x', ...(project ? { project } : {}) } }
    : { 'master:bbbbbbbb': { code: 'bbbbbbbb', sessionId: 'other', since: 'x' }, [`role:${ID}`]: { name: 'build', code: 'bbbbbbbb' } }
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: {} }))
  on('session.id', () => ({ value: ID }))
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('store.get', (_: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_: any, e: any) => {
    if (sets) sets[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', () => ({ value: undefined }))
  on('env.get', () => ({ value: '/h' }))
  on('clock.now', () => ({ value: NOW }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', (_: any, e: any) => ({ value: Object.keys(folder(e.path)).map(name => ({ name, mtimeMs: NOW - 1000 })) }))
  on('fs.read', (_: any, e: any) => ({ value: JSON.stringify(folder(e.path)[e.path.split('/').pop()]) }))
  on('fs.write', (_: any, e: any) => {
    written[e.path] = e.text
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('clock.every', () => ({ value: { cancel: () => {} } }))
}

const status = (name: string, state: string, steps: object[] = [], note = '', last = NOW, isMaster = false) => ({
  code: 'aaaaaaaa', name, isMaster, state, steps, note, last,
})

test('the band shows Maestro and worker sessions, waiting ones first', async ($, on) => {
  world(on, {
    [`aaaaaaaa-${ID}.json`]: status('Maestro', 'working', [{ text: 'Check status', status: 'in_progress' }], '', NOW, true),
    'aaaaaaaa-1.json': status('build', 'working', [{ text: 'Old', status: 'completed' }, { text: 'Build band', status: 'in_progress' }]),
    'aaaaaaaa-2.json': status('question', 'waiting', [], 'Which color?'),
    'aaaaaaaa-3.json': status('gone', 'ended'),
    'bbbbbbbb-5.json': { ...status('foreign', 'working'), code: 'bbbbbbbb' },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount(BAND)
  const text = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join('\n')
  expect(text).toContain('Check status')
  expect(text).toContain('❓ question · Which color?')
  expect(text).toContain('🔄 build ▰▰▰▱▱ 50 % · Build band')
  expect(text).toContain('🔄1')
  expect(text).toContain('❓1')
  expect(text.indexOf('question')).toBeLessThan(text.indexOf('build'))
  expect(text).not.toContain('gone')
  expect(text).not.toContain('foreign')
  await ui.unmount()
})

test('the band shows up even without worker sessions', async ($, on) => {
  world(on, {})
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, isWorking: false } })
  const text = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join('\n')
  expect(text).toContain('ready')
  expect(text).toContain('no worker session')
  await ui.unmount()
})

test('a worker session has no band', async ($, on) => {
  world(on, {}, {}, false)
  on('ui.render', ($e: any, e: any) => {
    const { Text } = $e.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('a task with a full-width ＠ in the marker makes the session a worker session', async ($, on) => {
  const set: Record<string, unknown> = {}
  const store: Record<string, unknown> = { 'master:bbbbbbbb': { code: 'bbbbbbbb', sessionId: 'other', since: 'x' } }
  on('session.id', () => ({ value: ID }))
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('store.get', (_: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_: any, e: any) => {
    set[e.key] = e.value
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  await $.prompt.submit({ text: 'Task: ⟦maestro:vocals＠bbbbbbbb⟧ Task' } as any)
  expect(set[`role:${ID}`]).toEqual({ name: 'vocals', code: 'bbbbbbbb' })
})

test('a worker session reports its list and its completion', async ($, on) => {
  const written: Record<string, string> = {}
  world(on, {}, written, false)
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [{ content: 'One', status: 'in_progress' }, { content: 'Two', status: 'pending' }] } as any)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true } as any)
  const path = `/h/.claude/maestro/status/bbbbbbbb-${ID}.json`
  let file = JSON.parse(written[path])
  expect(file.name).toBe('build')
  expect(file.steps.map((s: any) => s.status)).toEqual(['completed', 'in_progress'])
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'Everything built. More text.' } as any)
  file = JSON.parse(written[path])
  expect(file.note).toBe('Everything built.')
  expect(file.steps.every((s: any) => s.status === 'completed')).toBe(true)
})

const linesOf = async ($: any, on: any, files: Record<string, object>, width: number) => {
  world(on, files)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: width } })
  const text = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join('\n')
  await ui.unmount()
  return text
}

test('a long report gets short but stays readable', async ($, on) => {
  const text = await linesOf($, on, {
    'aaaaaaaa-1.json': status('guitar', 'done', [{ text: 'A', status: 'completed' }], 'Guitar done: 13 spots in the DI repaired, measured 0 deviating samples.'),
  }, 80)
  expect(text).toContain('☑️ guitar ▰▰▰▰▰ 100 % · 13 spots in the DI repaired')
  expect(text).not.toContain('measured')
})

test('in a narrow window the bar drops out, the percentage stays', async ($, on) => {
  const text = await linesOf($, on, {
    'aaaaaaaa-1.json': status('mix', 'working', [{ text: 'One', status: 'completed' }, { text: 'Build and fit chains per track in mix.py', status: 'in_progress' }]),
  }, 40)
  expect(text).toContain('🔄 mix 50 % · ')
  expect(text).not.toContain('▰')
  expect(text).toContain('…')
})

test('paused and quiet are distinguishable from done and working', async ($, on) => {
  const text = await linesOf($, on, {
    'aaaaaaaa-1.json': status('half', 'done', [{ text: 'A', status: 'completed' }, { text: 'B', status: 'pending' }]),
    'aaaaaaaa-2.json': status('quiet', 'working', [{ text: 'Measure', status: 'in_progress' }], '', NOW - 25 * 60_000),
  }, 80)
  expect(text).toContain('⏸️ half')
  expect(text).toContain('⚠️ quiet ▱▱▱▱▱ 0 % · 25 min quiet · Measure')
})

// --- Skill management ---

const DAYS = 24 * 60 * 60 * 1000
const usageOf = (id: string, task: string, loaded: string[], last: number, extra: object = {}) => ({
  sessionId: id, code: 'aaaaaaaa', name: 'build', task, assigned: [], result: 'done', last,
  loaded: loaded.map(skill => ({ skill, time: last })), ...extra,
})

function skillWorld(on: any, usage: Record<string, object>, notes: Record<string, object>, written: Record<string, string>, isMaster: boolean | null = false) {
  world(on, {}, written, isMaster, { usage, notes })
  on('command.list', () => ({
    value: [
      { name: 'help', description: 'Help', source: 'builtin' },
      { name: 'commit', description: 'Write commit', source: 'user' },
      { name: 'plugin-authoring', description: 'Build mods', source: 'plugin' },
      { name: 'mcp__x__prompt', description: 'MCP', source: 'mcp' },
      { name: 'old', description: 'Never used', source: 'user' },
    ],
  }))
  on('tool.call', () => ({ result: {} }))
}

const skillsStatus = async ($: any) => JSON.parse(((await $.tool.call({ tool: 'mcp__maestro__skills_status' } as any)) as any).result)

test('skills_status counts usage, names tasks without a skill and notes, but only cleans up after 30 days', async ($, on) => {
  skillWorld(on, {
    'a.json': usageOf('a', 'Build mod', ['commit', 'plugin-authoring'], NOW - 5 * DAYS),
    'b.json': usageOf('b', 'Shorten texts', [], NOW - 2 * DAYS),
    'c.json': usageOf('c', 'Polish texts', [], NOW - 1 * DAYS, { assigned: ['commit'] }),
  }, { 'h.json': { skill: 'commit', kind: 'correction', text: 'Style', time: NOW - DAYS } }, {})
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const s = await skillsStatus($)
  const commit = s.skills.find((k: any) => k.name === 'commit')
  expect(s.skills.map((k: any) => k.name).sort()).toEqual(['commit', 'old', 'plugin-authoring'])
  expect(commit).toMatchObject({ loaded: 1, done: 1, lastUsedDaysAgo: 5, assignedNotLoaded: 1, openNotes: 1 })
  expect(s.tasksWithoutSkill.map((a: any) => a.task).sort()).toEqual(['Polish texts', 'Shorten texts'])
  expect(s.notes).toHaveLength(1)
  expect(s.cleanupCandidates).toEqual([])
})

test('after 30 days of log skills_status names unused skills for cleanup', async ($, on) => {
  skillWorld(on, { 'a.json': usageOf('a', 'Build mod', ['commit', 'plugin-authoring'], NOW - 40 * DAYS) }, {}, {})
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const s = await skillsStatus($)
  expect(s.logDays).toBe(40)
  expect(s.cleanupCandidates.sort()).toEqual(['commit', 'old', 'plugin-authoring'])
})

test('skill.prompt writes the log and status of a worker session', async ($, on) => {
  const written: Record<string, string> = {}
  skillWorld(on, {}, {}, written)
  on('skill.prompt', () => ({ text: 'Skilltext' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const answer = await $.skill.prompt({ skill: 'commit', text: '' })
  expect(answer.text).toBe('Skilltext')
  await $.skill.prompt({ skill: 'commit', text: '' })
  const usage = JSON.parse(written[`/h/.claude/maestro/skills/usage/${ID}.json`])
  expect(usage.loaded.map((g: any) => g.skill)).toEqual(['commit'])
  expect(usage).toMatchObject({ sessionId: ID, code: 'bbbbbbbb', name: 'build', result: 'done' })
  const statusFile = JSON.parse(written[`/h/.claude/maestro/status/bbbbbbbb-${ID}.json`])
  expect(statusFile.loaded).toEqual(['commit'])
})

test('a session without Maestro and without a skill writes no log', async ($, on) => {
  const written: Record<string, string> = {}
  skillWorld(on, {}, {}, written, null)
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  await $.prompt.submit({ text: 'hello' } as any)
  expect(Object.keys(written).filter(p => p.includes('/skills/'))).toEqual([])
})

test('the task sets the assigned skills, "none" assigns nothing', async ($, on) => {
  const written: Record<string, string> = {}
  skillWorld(on, {}, {}, written)
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  const statusFile = () => JSON.parse(written[`/h/.claude/maestro/status/bbbbbbbb-${ID}.json`])
  const usage = () => JSON.parse(written[`/h/.claude/maestro/skills/usage/${ID}.json`])
  await $.prompt.submit({ text: '⟦maestro:build＠bbbbbbbb⟧ Task\nTask: Build mod\nSkills: plugin-authoring, commit\nWhere: x' } as any)
  expect(statusFile().assigned).toEqual(['plugin-authoring', 'commit'])
  expect(usage()).toMatchObject({ task: 'Build mod', assigned: ['plugin-authoring', 'commit'] })

  await $.prompt.submit({ text: '⟦maestro:build＠bbbbbbbb⟧ Task\nTask: Shorten texts\nSkills: none\nWhere: x' } as any)
  expect(statusFile().assigned).toEqual([])
  await $.prompt.submit({ text: '⟦maestro:build＠bbbbbbbb⟧ Follow-up\nTask: Continue\nSkills: commit' } as any)
  await $.prompt.submit({ text: '⟦maestro:build＠bbbbbbbb⟧ Another question without a skills line' } as any)
  expect(statusFile().assigned).toEqual(['commit'])
})

test('skill_note writes a file and leaves the skill untouched', async ($, on) => {
  const written: Record<string, string> = {}
  skillWorld(on, {}, {}, written, true)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__maestro__skill_note', skill: 'commit', kind: 'correction', text: 'Subject too long' } as any)
  const paths = Object.keys(written)
  expect(paths).toEqual([`/h/.claude/maestro/skills/notes/${NOW}-commit.json`])
  expect(JSON.parse(written[paths[0]])).toMatchObject({ skill: 'commit', kind: 'correction', text: 'Subject too long', time: NOW })
})

test('skill_note without a valid skill name writes nothing', async ($, on) => {
  const written: Record<string, string> = {}
  skillWorld(on, {}, {}, written, true)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__maestro__skill_note', skill: '../x', kind: 'error', text: 'a' } as any)
  await $.tool.call({ tool: 'mcp__maestro__skill_note', skill: 'commit', kind: 'error', text: '  ' } as any)
  expect(written).toEqual({})
})

test('skills_hide rejects special characters and changes nothing', async ($, on) => {
  const written: Record<string, string> = {}
  skillWorld(on, {}, {}, written, true)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const answer = async (skills: string[]) => JSON.parse((await $.tool.call({ tool: 'mcp__maestro__skills_hide', skills } as any) as any).result)
  const bad = await answer(['x"; rm -rf ~ #', '$(evil)'])
  expect(bad.command).toBeNull()
  expect(bad.rejected).toHaveLength(2)
  const mixed = await answer(['old', 'a b'])
  expect(mixed.command).toContain('"old":"name-only"')
  expect(mixed.command).not.toContain('a b')
  expect(mixed.rejected).toEqual(['a b'])
  expect(Object.keys(written).filter(p => !p.includes('/maestro/'))).toEqual([])
})

test('the band shows [name] for loaded and [name?] for unloaded skills', async ($, on) => {
  const text = await linesOf($, on, {
    'aaaaaaaa-1.json': { ...status('build', 'working', [{ text: 'One', status: 'in_progress' }]), loaded: ['commit'], assigned: ['commit'] },
    'aaaaaaaa-2.json': { ...status('text', 'working', [{ text: 'Two', status: 'in_progress' }]), assigned: ['writing'] },
    'aaaaaaaa-3.json': status('raw', 'working', [{ text: 'Three', status: 'in_progress' }]),
  }, 80)
  expect(text).toContain('build [commit] ▱')
  expect(text).toContain('text [writing?] ▱')
  expect(text).toContain('raw ▱')
  expect(text).not.toMatch(/raw \[/)
})

// --- Naming the master ---

test('master_name shortens the name, removes a duplicate 🎼 and sets the title', async ($, on) => {
  const set: Record<string, any> = {}
  const calls: any[] = []
  world(on, {}, {}, true, undefined, undefined, set)
  on('mcp.call', (_: any, e: any) => {
    calls.push(e)
    return { value: { content: [], isError: false } }
  })
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const long = '🎼 ' + 'x'.repeat(60)
  const answer = ((await $.tool.call({ tool: 'mcp__maestro__master_name', project: long } as any)) as any).result
  const project = set['master:aaaaaaaa'].project as string
  expect(project).toBe('x'.repeat(39) + '…')
  expect(project.length).toBe(40)
  expect(project).not.toContain('🎼')
  expect(answer).toContain(`🎼 ${project}`)
  const title = calls.find(a => a.tool === 'set_session_title')
  expect(title.args).toEqual({ session_id: 'self', title: `🎼 ${project}` })
})

test('if the mod cannot set the title, the tool names the finished title', async ($, on) => {
  world(on, {})
  on('mcp.call', () => {
    throw new Error('not connected')
  })
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const answer = ((await $.tool.call({ tool: 'mcp__maestro__master_name', project: 'Music' } as any)) as any).result
  expect(answer).toContain('"🎼 Music"')
  expect(answer).toContain('yourself')
})

test('the band shows the project name, a master without a name shows Maestro', async ($, on) => {
  world(on, {}, {}, true, undefined, 'Music')
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount(BAND)
  const text = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join('\n')
  expect(text).toContain('🎼 Music')
  expect(text).not.toContain('🎼 Maestro')
  await ui.unmount()
})

test('a master without a name shows 🎼 Maestro', async ($, on) => {
  const text = await linesOf($, on, {}, 80)
  expect(text).toContain('🎼 Maestro')
})
