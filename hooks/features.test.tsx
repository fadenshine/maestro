import { expect, mock, test } from 'claude-code/testing'

// Tests for open items, status after a restart, reported/checked, the band as a display, file conflicts, limit,
// effect of skill changes and approval cards. The world has an in-memory file system: whatever the mod writes,
// it reads back again, just like after a restart.
const ID = 'aaaaaaaa-0000-4000-8000-000000000000'
const CODE = 'aaaaaaaa'
const NOW = 1_800_000_000_000
const MINUTE = 60_000
const BAND = {
  plugin: 'maestro',
  component: 'AbovePrompt',
  surface: 'desktop',
  requestId: 'band',
  props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const
const START = { cwd: '/', surface: 'desktop', isInteractive: true } as const
const STATUS = (code = CODE, id = ID) => `/h/.claude/maestro/status/${code}-${id}.json`
const EXTRA = (name: string) => `/h/.claude/maestro/extra/${CODE}-${name}.json`
const OPEN = `/h/.claude/maestro/open/${CODE}.json`

type World = {
  files: Record<string, string>
  calls: { server: string; tool: string; args: any }[]
  clock: ReturnType<typeof mock.clock>
  store: Record<string, unknown>
  /** What the model reads next to every message. */
  contexts: (readonly string[] | undefined)[]
  sessionId: string
  /** Sits under every tool call, like the engine. */
  toolAnswer: () => unknown
  /** What arrives at the engine as a tool call, after all hooks of the mod. */
  toolIn: any[]
  approvalAnswer: unknown
}

function world(
  on: any,
  { role = 'master', files = {}, mcp, env = {} }: { role?: 'master' | 'worker' | 'free'; files?: Record<string, unknown>; mcp?: (tool: string, args: any) => unknown; env?: Record<string, string> } = {},
): World {
  const w: World = {
    files: Object.fromEntries(Object.entries(files).map(([p, v]) => [p, typeof v === 'string' ? v : JSON.stringify(v)])),
    calls: [],
    clock: mock.clock(on, { now: NOW }),
    contexts: [],
    sessionId: ID,
    toolAnswer: () => ({ result: {} }),
    toolIn: [],
    approvalAnswer: {},
    store:
      role === 'master'
        ? { [`master:${CODE}`]: { code: CODE, sessionId: ID, since: 'x' } }
        : role === 'worker'
          ? { [`master:${CODE}`]: { code: CODE, sessionId: 'other', since: 'x' }, [`role:${ID}`]: { name: 'build', code: CODE } }
          : {},
  }
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.end', (_: any, e: any) => ({ sessionId: e.sessionId }))
  on('tool.register', () => ({ value: {} }))
  on('session.id', () => ({ value: w.sessionId }))
  on('store.keys', () => ({ value: Object.keys(w.store) }))
  on('store.get', (_: any, e: any) => ({ value: w.store[e.key] }))
  on('store.set', (_: any, e: any) => {
    w.store[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', (_: any, e: any) => {
    delete w.store[e.key]
    return { value: undefined }
  })
  on('env.get', (_: any, e: any) => ({ value: e.name === 'HOME' ? '/h' : env[e.name] }))
  on('fs.exists', (_: any, e: any) => ({
    value: e.path in w.files || Object.keys(w.files).some(p => p.startsWith(`${e.path}/`)),
  }))
  on('fs.list', (_: any, e: any) => ({
    value: Object.keys(w.files)
      .filter(p => p.startsWith(`${e.path}/`) && !p.slice(e.path.length + 1).includes('/'))
      .map(p => ({ name: p.slice(e.path.length + 1), mtimeMs: w.clock.now() - 1000 })),
  }))
  on('fs.read', (_: any, e: any) => {
    if (!(e.path in w.files)) throw new Error('missing')
    return { value: w.files[e.path] }
  })
  on('fs.write', (_: any, e: any) => {
    w.files[e.path] = e.text
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('mcp.call', (_: any, e: any) => {
    w.calls.push({ server: e.server, tool: e.tool, args: e.args })
    const answer = mcp?.(e.tool, e.args)
    return { value: answer ?? { content: [{ type: 'text', text: '{}' }], isError: false } }
  })
  on('tool.call', (_: any, e: any) => {
    w.toolIn.push(e)
    return w.toolAnswer()
  })
  on('classic.PermissionRequest', () => w.approvalAnswer)
  on('prompt.submit', (_: any, e: any) => {
    w.contexts.push(e.context)
    return { text: e.text }
  })
  on('turn.complete', () => ({ text: '' }))
  on('skill.prompt', () => ({ text: '' }))
  on('ui.render', ($e: any, e: any) => {
    const { Text } = $e.ui.resolve(e)
    return <Text>engine</Text>
  })
  return w
}

const statusFile = (name: string, state: string, steps: object[] = [], note = '', last = NOW, extra: object = {}) => ({
  code: CODE, name, isMaster: false, state, steps, note, last, ...extra,
})
const DONE = [{ text: 'A', status: 'completed' }]
const bandText = async ($: any, props: object = {}) => {
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, ...props } })
  const text = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join('\n')
  return { ui, text }
}
const readBand = async ($: any, props: object = {}) => {
  const { ui, text } = await bandText($, props)
  await ui.unmount()
  return text
}
const callTool = async ($: any, name: string, input: object = {}) =>
  ((await $.tool.call({ tool: `mcp__maestro__${name}`, ...input } as any)) as any).result as string
const message = ($: any, text: string, extra: object = {}) => $.prompt.submit({ text, ...extra } as any)
const roundEnd = ($: any, answer: string, extra: object = {}) =>
  $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', ...extra } as any)

// --- A. Open items ---

test('open_add and open_close keep the file, the header counts along', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  expect(await readBand($)).not.toContain('📌')

  expect(await callTool($, 'open_add', { text: 'Check dark mode', kind: 'idea' })).toContain('p1')
  await callTool($, 'open_add', { text: 'Which color?', kind: 'question', source: 'build' })
  expect(await readBand($)).toContain('📌 2')

  const file = JSON.parse(w.files[OPEN])
  expect(file.items[1]).toMatchObject({ id: 'p2', text: 'Which color?', kind: 'question', source: 'build', time: NOW, status: 'open' })

  expect(await callTool($, 'open_close', { id: 'p1', reason: '  ' })).toContain('reason is missing')
  expect(JSON.parse(w.files[OPEN]).items[0].status).toBe('open')
  await callTool($, 'open_close', { id: 'p1', reason: 'Commit abc' })
  await callTool($, 'open_close', { id: 'p2', status: 'dropped', reason: 'User: "drop it"' })
  const closed = JSON.parse(w.files[OPEN]).items
  expect(closed[0]).toMatchObject({ status: 'done', reason: 'Commit abc' })
  expect(closed[1]).toMatchObject({ status: 'dropped' })
  expect(await readBand($)).not.toContain('📌')

  const list = JSON.parse(await callTool($, 'open_list', { all: true }))
  expect(list.openCount).toBe(0)
  expect(list.items).toHaveLength(2)
  expect(JSON.parse(await callTool($, 'open_list')).items).toHaveLength(0)

  // An id is never handed out again, even when everything is closed.
  expect(await callTool($, 'open_add', { text: 'New', kind: 'task' })).toContain('p3')
})

test('dropped suggestions with their reason only come from open_list on request, also after a restart', async ($, on) => {
  world(on, { files: { [OPEN]: { items: [
    { id: 'p1', text: 'Suggest skill foo', kind: 'idea', source: 'research', time: 1, status: 'open' },
  ] } } })
  await $.session.start(START)
  await callTool($, 'open_close', { id: 'p1', status: 'dropped', reason: 'User: "I do not need it"' })

  await $.session.start(START)
  expect(JSON.parse(await callTool($, 'open_list')).items).toEqual([])
  const [item] = JSON.parse(await callTool($, 'open_list', { all: true })).items
  expect(item).toMatchObject({ id: 'p1', text: 'Suggest skill foo', status: 'dropped', reason: 'User: "I do not need it"' })
})

test('the same item is not recorded twice, nonsense is rejected', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await callTool($, 'open_add', { text: 'Check dark mode', kind: 'idea' })
  expect(await callTool($, 'open_add', { text: 'check dark mode', kind: 'idea' })).toContain('Already')
  expect(await callTool($, 'open_add', { text: ' ', kind: 'idea' })).toContain('text is missing')
  expect(await callTool($, 'open_add', { text: 'x', kind: 'wish' })).toContain('kind must')
  expect(JSON.parse(w.files[OPEN]).items).toHaveLength(1)
})

test('only the master writes open items', async ($, on) => {
  const w = world(on, { role: 'worker' })
  await $.session.start(START)
  expect(await callTool($, 'open_add', { text: 'x', kind: 'idea' })).toContain('Only the master')
  expect(w.files[OPEN]).toBeUndefined()
})

test('a worker session does not get the list', async ($, on) => {
  const w = world(on, { role: 'worker', files: { [OPEN]: { items: [{ id: 'p1', text: 'x', kind: 'idea', source: 'chat', time: 1, status: 'open' }] } } })
  await message($, 'hello')
  expect(w.contexts[0]).toBeUndefined()
})

test('every message to the master carries the open list', async ($, on) => {
  const w = world(on, { files: { [OPEN]: { items: [
    { id: 'p1', text: 'Check dark mode', kind: 'idea', source: 'chat', time: 1, status: 'open' },
    { id: 'p2', text: 'Already finished', kind: 'idea', source: 'chat', time: 1, status: 'done', reason: 'x' },
  ] } } })
  await message($, 'hello')
  expect(w.contexts[0]?.join('\n')).toContain('p1 [idea] Check dark mode')
  expect(w.contexts[0]?.join('\n')).not.toContain('Already finished')
})

test('without open items the mod appends no context', async ($, on) => {
  const w = world(on)
  await $.skill.prompt({ skill: 'maestro', text: '' })
  await message($, 'hello')
  expect(w.contexts[0]).toBeUndefined()
})

test('the keyword check reminds once of a suggestion without open_add and records nothing itself', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await roundEnd($, 'Done. I recommend adding the docs later.')
  expect(JSON.parse(w.files[OPEN]).items).toEqual([])

  await message($, 'go on')
  expect(w.contexts[0]?.join('\n')).toContain('I recommend')
  expect(w.contexts[0]?.join('\n')).toContain('open_add')
  await message($, 'something else')
  expect(w.contexts[1]).toBeUndefined()
})

test('the keyword check stays quiet when open_add ran or the answer has nothing open', async ($, on) => {
  const w = world(on)
  await $.session.start(START)

  await callTool($, 'open_add', { text: 'Docs', kind: 'idea' })
  await roundEnd($, 'I recommend adding the docs later.')
  expect(JSON.parse(w.files[OPEN]).remind).toEqual([])

  await roundEnd($, 'Band built, 21 tests pass.')
  await roundEnd($, '📌 3 open, the docs are still open.')
  await roundEnd($, 'Example:\n```\nlater still open?\n```\nDone.')
  expect(JSON.parse(w.files[OPEN]).remind).toEqual([])

  // After a round with open_add, the next one counts for itself again.
  await roundEnd($, 'Should I also rework the tests?')
  expect(JSON.parse(w.files[OPEN]).remind).toEqual(['Should I also rework the tests?'])
})

test('the keyword check does not check a subagent', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await roundEnd($, 'Should I?', { agentId: 'a1' })
  expect(w.files[OPEN]).toBeUndefined()
})

test('a worker session also writes nothing to the open list at the end of a round', async ($, on) => {
  const w = world(on, { role: 'worker' })
  await $.session.start(START)
  await roundEnd($, 'Should I?')
  expect(w.files[OPEN]).toBeUndefined()
})

test('the open list survives /clear and a message afterwards names it', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await callTool($, 'open_add', { text: 'Check dark mode', kind: 'idea' })
  await $.session.end({ reason: 'clear', sessionId: ID, resume: {} } as any)
  w.sessionId = 'bbbbbbbb-new'
  await message($, 'go on')
  const context = w.contexts[0]?.join('\n')
  expect(context).toContain('handoff-aaaaaaaa')
  expect(context).toContain('Check dark mode')
  expect((w.store[`master:${CODE}`] as any).sessionId).toBe('bbbbbbbb-new')
})

test('a broken file is put aside and never overwritten', async ($, on) => {
  const w = world(on, { files: { [OPEN]: '{ "items": [ {"id": "p1", half' } })
  await $.session.start(START)
  expect(await readBand($)).toContain('🎼 Maestro')
  expect(await callTool($, 'open_add', { text: 'New', kind: 'idea' })).toContain('.broken')
  const aside = Object.keys(w.files).find(p => p.includes('.broken-')) as string
  expect(w.files[aside]).toContain('half')
  expect(JSON.parse(w.files[OPEN]).items).toHaveLength(1)
})

test('open items from an older version without fields stay readable', async ($, on) => {
  world(on, { files: { [OPEN]: { items: [{ id: 'p7', text: 'Old' }, { broken: true }, 'nothing'] } } })
  await $.session.start(START)
  expect(await readBand($)).toContain('📌 1')
  const list = JSON.parse(await callTool($, 'open_list'))
  expect(list.items[0]).toMatchObject({ id: 'p7', kind: 'idea', source: 'chat', status: 'open' })
  expect(await callTool($, 'open_add', { text: 'New', kind: 'idea' })).toContain('p8')
})

// --- 1. Status after a restart ---

test('a restart restores list, skills, task and assignment', async ($, on) => {
  const w = world(on, {
    role: 'worker',
    files: {
      [STATUS()]: statusFile('build', 'ended', [{ text: 'One', status: 'completed' }, { text: 'Two', status: 'in_progress' }], 'last', NOW - 5000, { loaded: ['commit'], assigned: ['commit', 'mod'] }),
      [`/h/.claude/maestro/skills/usage/${ID}.json`]: {
        sessionId: ID, code: CODE, name: 'build', task: 'Build mod', assigned: ['commit', 'mod'],
        loaded: [{ skill: 'commit', time: NOW - 9000 }], result: 'running', last: NOW - 5000,
      },
    },
  })
  await $.session.start(START)

  const status = JSON.parse(w.files[STATUS()])
  expect(status.state).toBe('done')
  expect(status.steps.map((s: any) => s.text)).toEqual(['One', 'Two'])
  expect(status.note).toBe('last')
  expect(status.assigned).toEqual(['commit', 'mod'])
  expect(status.loaded).toEqual(['commit'])

  // The next progress carries on from the restored list.
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true } as any)
  expect(JSON.parse(w.files[STATUS()]).steps.every((s: any) => s.status === 'completed')).toBe(true)

  // The log is continued instead of emptied: task and load time stay.
  await roundEnd($, 'Done.')
  const usage = JSON.parse(w.files[`/h/.claude/maestro/skills/usage/${ID}.json`])
  expect(usage.task).toBe('Build mod')
  expect(usage.loaded).toEqual([{ skill: 'commit', time: NOW - 9000 }])
})

test('a waiting session keeps waiting after the restart', async ($, on) => {
  const w = world(on, {
    role: 'worker',
    files: { [STATUS()]: statusFile('build', 'ended', DONE, 'Which color?', NOW - 5000, { blocked: true }) },
  })
  await $.session.start(START)
  expect(JSON.parse(w.files[STATUS()])).toMatchObject({ state: 'waiting', note: 'Which color?', blocked: true })
})

test('an unchanged status is not rewritten on reload', async ($, on) => {
  const original = statusFile('build', 'done', DONE, 'done', NOW - 60_000)
  const w = world(on, { role: 'worker', files: { [STATUS()]: original } })
  await $.session.start(START)
  expect(JSON.parse(w.files[STATUS()]).last).toBe(NOW - 60_000)
})

test('another session id starts empty, even with an old status of the same code', async ($, on) => {
  const w = world(on, {
    role: 'worker',
    files: { [STATUS(CODE, 'other-id')]: statusFile('build', 'ended', DONE, 'foreign') },
  })
  await $.session.start(START)
  await message($, 'go')
  expect(JSON.parse(w.files[STATUS()]).steps).toEqual([])
  expect(JSON.parse(w.files[STATUS()]).note).toBe('')
})

test('a status from an older version without new fields is still picked up', async ($, on) => {
  const w = world(on, {
    role: 'worker',
    files: { [STATUS()]: { code: CODE, name: 'build', isMaster: false, state: 'ended', steps: [{ text: 'One', status: 'in_progress' }], note: '', last: NOW - 1 } },
  })
  await $.session.start(START)
  expect(JSON.parse(w.files[STATUS()])).toMatchObject({ state: 'done', blocked: false })
})

test('a broken status file does not hold up the start', async ($, on) => {
  world(on, { role: 'worker', files: { [STATUS()]: '{ broken' } })
  await $.session.start(START)
  await message($, 'go')
})

// --- 2. Reported and checked ---

test('reported done is ☑️ and stays; only session_checked makes ✅, which goes after 30 minutes', async ($, on) => {
  const w = world(on, { files: { [STATUS(CODE, 'one')]: statusFile('build', 'done', DONE, 'Band built', NOW - 3 * 3_600_000) } })
  await $.session.start(START)
  let text = await readBand($)
  expect(text).toContain('☑️ build')
  expect(text).toContain('☑️1')

  expect(await callTool($, 'session_checked', { session: 'build' })).toContain('✅')
  text = await readBand($)
  expect(text).toContain('✅ build')
  expect(text).not.toContain('☑️')

  await w.clock.advance(29 * MINUTE)
  expect(await readBand($)).toContain('✅ build')
  await w.clock.advance(2 * MINUTE)
  expect(await readBand($)).not.toContain('build')
})

test('new work after the check lifts ✅', async ($, on) => {
  const path = STATUS(CODE, 'one')
  const w = world(on, { files: { [path]: statusFile('build', 'done', DONE, 'Band built', NOW - 1000) } })
  await $.session.start(START)
  await callTool($, 'session_checked', { session: 'build' })
  await w.clock.advance(5000)
  w.files[path] = JSON.stringify(statusFile('build', 'done', DONE, 'Built more', w.clock.now()))
  await w.clock.advance(3000)
  expect(await readBand($)).toContain('☑️ build')
})

test('session_checked rejects running, paused and unknown sessions', async ($, on) => {
  const w = world(on, { files: {
    [STATUS(CODE, 'a')]: statusFile('running', 'working', [{ text: 'X', status: 'in_progress' }]),
    [STATUS(CODE, 'b')]: statusFile('pause', 'done', [{ text: 'X', status: 'pending' }]),
  } })
  await $.session.start(START)
  expect(await callTool($, 'session_checked', { session: 'running' })).toContain('has not reported done yet')
  expect(await callTool($, 'session_checked', { session: 'pause' })).toContain('has not reported done yet')
  const gone = await callTool($, 'session_checked', { session: 'doesnotexist' })
  expect(gone).toContain('running')
  expect(Object.keys(w.files).some(p => p.includes('/checked/'))).toBe(false)
})

test('only the master may check', async ($, on) => {
  world(on, { role: 'worker' })
  await $.session.start(START)
  expect(await callTool($, 'session_checked', { session: 'build' })).toContain('Only the master')
})

test('status files from older versions without a check show ☑️, a crashed worker disappears after a day', async ($, on) => {
  world(on, { files: {
    [STATUS(CODE, 'a')]: statusFile('old', 'done', [], '', NOW - 2 * 86_400_000),
    [STATUS(CODE, 'b')]: statusFile('dead', 'working', [{ text: 'X', status: 'in_progress' }], '', NOW - 2 * 86_400_000),
  } })
  await $.session.start(START)
  const text = await readBand($)
  expect(text).toContain('☑️ old')
  expect(text).not.toContain('dead')
})

// --- 3. Band as a pure display ---

const withHostId = (name: string, state: string, extra: object = {}, id = name) => ({
  [STATUS(CODE, id)]: statusFile(name, state, DONE, 'Text', NOW, extra),
  [EXTRA(id)]: { hostId: `local_0000-${name}`, paths: [] },
})
const statusRows = async (ui: any) =>
  (await ui.findAll({ type: 'Text' })).map((t: any) => t.text as string).filter((t: string) => /^(❓|⚠️|🔄|⏸️|☑️|✅|…)/u.test(t))

test('a worker session writes its local id, outside the app none', async ($, on) => {
  const w = world(on, { role: 'worker', env: { CLAUDE_CODE_HOST_SESSION_ID: 'local_abc' } })
  await $.session.start(START)
  await message($, 'go')
  expect(JSON.parse(w.files[EXTRA(ID)]).hostId).toBe('local_abc')
})

test('without a host id there is none in the extra file either', async ($, on) => {
  const w = world(on, { role: 'worker' })
  await $.session.start(START)
  await message($, 'go')
  expect(JSON.parse(w.files[EXTRA(ID)]).hostId).toBeUndefined()
})

for (const surface of ['desktop', 'terminal'] as const) {
  test(`the band has no controls in the ${surface} window and calls nothing`, async ($, on) => {
    const w = world(on, { files: { ...withHostId('question', 'waiting', { blocked: true }), ...withHostId('build', 'working') } })
    await $.session.start(START)
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
    expect(await ui.findAll({ type: 'Input' })).toHaveLength(0)
    expect(await ui.findAll({ type: 'Select' })).toHaveLength(0)
    expect((await statusRows(ui)).length).toBe(2)
    expect(w.calls.filter(a => ['open_session_in', 'stop_session', 'send_message'].includes(a.tool))).toHaveLength(0)
    await ui.unmount()
  })
}

test('the band stays compact with many sessions, the most urgent on top, the rest counted', async ($, on) => {
  const files = Object.assign(
    {},
    withHostId('s-question', 'waiting'),
    ...['a', 'b', 'c'].map(n => withHostId(`s-${n}`, 'working')),
    ...['d', 'e'].map(n => withHostId(`s-${n}`, 'done')),
  )
  world(on, { files })
  await $.session.start(START)
  // On desktop `maxRows` is always 12: it must not make the band bigger.
  const ui = await $.ui.mount(BAND)
  const rows = await statusRows(ui)
  expect(rows).toHaveLength(4)
  expect(rows[0]).toContain('❓ s-question')
  expect(rows[3]).toBe('… and 3 more: 🔄1 ☑️2')
  await ui.unmount()
})

test('exactly as many sessions as there is room for need no summary row', async ($, on) => {
  world(on, { files: Object.assign({}, ...['a', 'b', 'c', 'd'].map(n => withHostId(`s-${n}`, 'working'))) })
  await $.session.start(START)
  const ui = await $.ui.mount(BAND)
  const rows = await statusRows(ui)
  expect(rows).toHaveLength(4)
  expect(rows.join('\n')).not.toContain('more')
  await ui.unmount()
})

test('a small maxRows shrinks the band further', async ($, on) => {
  world(on, { files: Object.assign({}, ...['a', 'b', 'c'].map(n => withHostId(`s-${n}`, 'working'))) })
  await $.session.start(START)
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, maxRows: 2 } })
  expect(await statusRows(ui)).toEqual(['… 3 more: 🔄3'])
  await ui.unmount()
})

// --- 4. File conflicts ---

test('Write, Edit and NotebookEdit write their paths to the extra file, also from subagents', async ($, on) => {
  const w = world(on, { role: 'worker' })
  await $.session.start(START)
  await $.tool.call({ tool: 'Write', file_path: '/p/a.ts', content: 'x' } as any)
  await $.tool.call({ tool: 'Edit', file_path: '/p/a.ts', old_string: 'x', new_string: 'y' } as any)
  await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/p/n.ipynb' } as any)
  await $.tool.call({ tool: 'Edit', file_path: '/p/agent.ts', agentId: 'a1' } as any)
  await $.tool.call({ tool: 'Read', file_path: '/p/read-only.ts' } as any)
  expect(JSON.parse(w.files[EXTRA(ID)]).paths).toEqual(['/p/a.ts', '/p/n.ipynb', '/p/agent.ts'])
})

test('a denied call does not count as a change', async ($, on) => {
  const w = world(on, { role: 'worker' })
  w.toolAnswer = () => ({ deny: 'no' })
  await $.session.start(START)
  await message($, 'go')
  await $.tool.call({ tool: 'Write', file_path: '/p/a.ts', content: 'x' } as any).catch(() => undefined)
  expect(JSON.parse(w.files[EXTRA(ID)]).paths).toEqual([])
})

test('two running sessions with the same file give ⚠️ with file and names', async ($, on) => {
  world(on, { files: {
    [STATUS(CODE, 'a')]: statusFile('build', 'working', [{ text: 'X', status: 'in_progress' }]),
    [EXTRA('a')]: { paths: ['/p/shared.ts', '/p/a.ts'] },
    [STATUS(CODE, 'b')]: statusFile('docs', 'waiting'),
    [EXTRA('b')]: { paths: ['/p/shared.ts'] },
  } })
  await $.session.start(START)
  const text = await readBand($)
  expect(text).toContain('⚠️ File conflict build + docs: shared.ts')
  expect(text).not.toContain('a.ts')
})

test('A waits, B reports done: the warning stays until both are checked', async ($, on) => {
  const w = world(on, { files: {
    [STATUS(CODE, 'a')]: statusFile('probe-a', 'waiting', [], 'Question'),
    [EXTRA('a')]: { paths: ['/p/shared.ts'] },
    [STATUS(CODE, 'b')]: statusFile('probe-b', 'working', [{ text: 'X', status: 'in_progress' }]),
    [EXTRA('b')]: { paths: ['/p/shared.ts'] },
  } })
  await $.session.start(START)
  expect(await readBand($)).toContain('⚠️ File conflict')

  // B overwrites the file and reports done: exactly then the warning must not disappear.
  await w.clock.advance(3000)
  w.files[STATUS(CODE, 'b')] = JSON.stringify(statusFile('probe-b', 'done', DONE, 'Done', w.clock.now()))
  await w.clock.advance(3000)
  let text = await readBand($)
  expect(text).toContain('☑️ probe-b')
  expect(text).toContain('⚠️ File conflict probe-a + probe-b: shared.ts')

  // Even when both have reported done, nothing is checked yet.
  w.files[STATUS(CODE, 'a')] = JSON.stringify(statusFile('probe-a', 'done', DONE, 'Done', w.clock.now()))
  await w.clock.advance(3000)
  expect(await readBand($)).toContain('⚠️ File conflict')

  // A checked session drops out of the comparison; with only one session there is no conflict any more.
  await callTool($, 'session_checked', { session: 'probe-b' })
  expect(await readBand($)).not.toContain('File conflict')
  await callTool($, 'session_checked', { session: 'probe-a' })
  text = await readBand($)
  expect(text).toContain('✅ probe-a')
  expect(text).not.toContain('File conflict')
})

test('a paused session also counts for the conflict, an ended one does not', async ($, on) => {
  const w = world(on, { files: {
    [STATUS(CODE, 'a')]: statusFile('build', 'working', [{ text: 'X', status: 'in_progress' }]),
    [EXTRA('a')]: { paths: ['/p/shared.ts'] },
    [STATUS(CODE, 'b')]: statusFile('pause', 'done', [{ text: 'X', status: 'pending' }]),
    [EXTRA('b')]: { paths: ['/p/shared.ts'] },
  } })
  await $.session.start(START)
  expect(await readBand($)).toContain('⚠️ File conflict build + pause')
  w.files[STATUS(CODE, 'b')] = JSON.stringify(statusFile('pause', 'ended', [{ text: 'X', status: 'pending' }]))
  await w.clock.advance(3000)
  expect(await readBand($)).not.toContain('File conflict')
})

test('a new task takes the old files of a finished session out of the comparison', async ($, on) => {
  const w = world(on, { role: 'worker', files: { [STATUS()]: statusFile('build', 'done', DONE), [EXTRA(ID)]: { paths: ['/p/shared.ts'] } } })
  await $.session.start(START)
  expect(JSON.parse(w.files[EXTRA(ID)]).paths).toEqual(['/p/shared.ts'])
  await message($, `⟦maestro:build＠${CODE}⟧ Brief\nTask: Something new`)
  expect(JSON.parse(w.files[EXTRA(ID)]).paths).toEqual([])
})

test('checked sessions, other paths and statuses without an extra file give no conflict', async ($, on) => {
  world(on, { files: {
    [STATUS(CODE, 'a')]: statusFile('build', 'working', [{ text: 'X', status: 'in_progress' }]),
    [EXTRA('a')]: { paths: ['/p/shared.ts'] },
    [STATUS(CODE, 'b')]: statusFile('finished', 'done', DONE, '', NOW - 1000),
    [EXTRA('b')]: { paths: ['/p/shared.ts'] },
    [`/h/.claude/maestro/checked/${CODE}.json`]: { b: NOW },
    [STATUS(CODE, 'c')]: statusFile('old', 'working', [{ text: 'X', status: 'in_progress' }]),
    [EXTRA('c')]: { paths: ['/worktree/shared.ts'] },
    [STATUS(CODE, 'd')]: statusFile('ancient', 'working', [{ text: 'X', status: 'in_progress' }]),
  } })
  await $.session.start(START)
  expect(await readBand($)).not.toContain('File conflict')
})

test('a new task starts the path list afresh', async ($, on) => {
  const w = world(on, { role: 'worker' })
  await $.session.start(START)
  await message($, `⟦maestro:build＠${CODE}⟧ Brief\nTask: One`)
  await $.tool.call({ tool: 'Write', file_path: '/p/old.ts', content: 'x' } as any)
  await message($, `⟦maestro:build＠${CODE}⟧ Follow-up without task`)
  expect(JSON.parse(w.files[EXTRA(ID)]).paths).toEqual(['/p/old.ts'])
  await message($, `⟦maestro:build＠${CODE}⟧ Brief\nTask: Two`)
  expect(JSON.parse(w.files[EXTRA(ID)]).paths).toEqual([])
})

test('the paths survive a restart and are not emptied', async ($, on) => {
  const w = world(on, { role: 'worker', files: {
    [STATUS()]: statusFile('build', 'ended', DONE),
    [EXTRA(ID)]: { paths: ['/p/old.ts'] },
  } })
  await $.session.start(START)
  expect(JSON.parse(w.files[EXTRA(ID)]).paths).toEqual(['/p/old.ts'])
})

// --- 5. Limits ---

const usageReply = (percent: number) => ({
  content: [{ type: 'text', text: JSON.stringify({ plan: { status: 'ok', windows: [
    { label: 'Weekly · all models', percentUsed: 99 },
    { label: '5-hour limit', percentUsed: percent },
  ] } }) }],
  isError: false,
})

test('the header shows the 5-hour limit, highlighted from 80 %', async ($, on) => {
  let percent = 25
  const w = world(on, { mcp: tool => (tool === 'get_usage' ? usageReply(percent) : undefined) })
  await $.session.start(START)
  await w.clock.advance(3000)
  let text = await readBand($)
  expect(text).toContain('5h 25 %')
  expect(text).not.toContain('⚠️')

  percent = 82
  await w.clock.advance(MINUTE + 3000)
  text = await readBand($)
  expect(text).toContain('⚠️ 5h 82 %')
  expect(text).not.toContain('5h 25 %')
})

test('get_usage runs at most once a minute', async ($, on) => {
  const w = world(on, { mcp: tool => (tool === 'get_usage' ? usageReply(10) : undefined) })
  await $.session.start(START)
  await w.clock.advance(57_000)
  expect(w.calls.filter(a => a.tool === 'get_usage')).toHaveLength(1)
  await w.clock.advance(3000)
  expect(w.calls.filter(a => a.tool === 'get_usage')).toHaveLength(2)
})

for (const [scenario, answer] of [
  ['an exception', () => { throw new Error('gone') }],
  ['an error', () => ({ content: [], isError: true })],
  ['no JSON', () => ({ content: [{ type: 'text', text: 'not json' }], isError: false })],
  ['no plan', () => ({ content: [{ type: 'text', text: '{"plan":{"status":"not_applicable"}}' }], isError: false })],
] as const) {
  test(`when get_usage returns ${scenario}, the band shows nothing for it and keeps running`, async ($, on) => {
    const w = world(on, { mcp: tool => (tool === 'get_usage' ? answer() : undefined) })
    await $.session.start(START)
    await w.clock.advance(MINUTE)
    const text = await readBand($)
    expect(text).toContain('🎼 Maestro')
    expect(text).not.toContain('5h')
  })
}

test('if the query fails later, the old number disappears', async ($, on) => {
  let works = true
  const w = world(on, { mcp: tool => {
    if (tool !== 'get_usage') return undefined
    if (!works) throw new Error('gone')
    return usageReply(70)
  } })
  await $.session.start(START)
  await w.clock.advance(3000)
  expect(await readBand($)).toContain('5h 70 %')
  works = false
  await w.clock.advance(MINUTE + 3000)
  expect(await readBand($)).not.toContain('5h')
})

test('the header stays one line: important things first, the text last', async ($, on) => {
  const w = world(on, {
    mcp: tool => (tool === 'get_usage' ? usageReply(90) : undefined),
    files: {
      [OPEN]: { items: [{ id: 'p1', text: 'x', kind: 'idea', source: 'chat', time: 1, status: 'open' }] },
      [STATUS(CODE, ID)]: { ...statusFile('Maestro', 'working', [{ text: 'A very long step, which no longer fits the narrow header', status: 'in_progress' }]), isMaster: true },
      [STATUS(CODE, 'a')]: statusFile('question', 'waiting'),
    },
  })
  await $.session.start(START)
  await message($, 'go')
  await callTool($, 'master_name', { project: 'Music' })
  await w.clock.advance(3000)
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, isWorking: true, bodyColumns: 44 } })
  const head = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).find((t: string) => t.startsWith('🎼')) as string
  await ui.unmount()
  expect(head).not.toContain('\n')
  const order = ['🎼 Music', '📌 1', '⚠️ 5h 90 %', '❓1'].map(t => head.indexOf(t))
  expect(order.every(i => i >= 0)).toBe(true)
  expect(order).toEqual([...order].sort((a, b) => a - b))
  expect(head.indexOf('A very')).toBeGreaterThan(order[3])
})

// --- 6. Effect of skill changes ---

const DAY = 86_400_000
const used = (id: string, skill: string, time: number, result: string) => ({
  [`/h/.claude/maestro/skills/usage/${id}.json`]: { sessionId: id, code: CODE, name: 'x', task: 'a', assigned: [], result, last: time, loaded: [{ skill, time }] },
})
const many = (skill: string, from: number, done: number, paused: number, prefix: string) => {
  const files: Record<string, object> = {}
  for (let i = 0; i < done + paused; i++) Object.assign(files, used(`${prefix}${i}`, skill, from + i * 1000, i < done ? 'done' : 'paused'))
  return files
}
const BACKUP = '/h/.claude/maestro/skill-backup/commit-1'

function skillWorld(on: any, files: Record<string, object> = {}) {
  const w = world(on, { files: { [`${BACKUP}/SKILL.md`]: 'old', ...files } })
  on('command.list', () => ({ value: [{ name: 'commit', description: 'd', source: 'user' }] }))
  return w
}
const readChanges = async ($: any) => JSON.parse(await callTool($, 'skills_status')).changes

test('skill_change records skill, date and backup and changes nothing itself', async ($, on) => {
  const w = skillWorld(on)
  await $.session.start(START)
  const before = Object.keys(w.files).filter(p => !p.includes('/changes/') && !p.includes('/status/') && !p.includes('/extra/'))
  await callTool($, 'skill_change', { skill: 'commit', backup: BACKUP })
  const path = Object.keys(w.files).find(p => p.includes('/skills/changes/')) as string
  expect(JSON.parse(w.files[path])).toEqual({ skill: 'commit', backup: BACKUP, time: NOW })
  expect(Object.keys(w.files).filter(p => !p.includes('/changes/') && !p.includes('/status/') && !p.includes('/extra/'))).toEqual(before)
})

test('skill_change needs an existing backup folder and a valid name', async ($, on) => {
  const w = skillWorld(on)
  await $.session.start(START)
  expect(await callTool($, 'skill_change', { skill: 'commit', backup: '/doesnotexist' })).toContain('does not exist')
  expect(await callTool($, 'skill_change', { skill: '../x', backup: BACKUP })).toContain('Nothing recorded')
  expect(Object.keys(w.files).some(p => p.includes('/changes/'))).toBe(false)
  expect(await callTool($, 'skill_change', { skill: 'commit', backup: '~/.claude/maestro/skill-backup/commit-1' })).toContain('recorded')
})

test('skills_status shows the effect: worse after the change', async ($, on) => {
  const AT = NOW - 10 * DAY
  skillWorld(on, {
    ...many('commit', AT - 5 * DAY, 5, 0, 'v'),
    ...many('commit', AT + DAY, 2, 3, 'n'),
    [`/h/.claude/maestro/skills/notes/1-commit.json`]: { skill: 'commit', kind: 'error', text: 'x', time: AT + 2 * DAY },
    [`/h/.claude/maestro/skills/changes/1-commit.json`]: { skill: 'commit', backup: BACKUP, time: AT },
  })
  await $.session.start(START)
  const [a] = await readChanges($)
  expect(a).toMatchObject({
    skill: 'commit',
    backup: BACKUP,
    before: { uses: 5, successRate: 100, notes: 0 },
    after: { uses: 5, successRate: 40, notes: 1 },
    trend: 'worse',
  })
  expect(a.note).toBeUndefined()
})

test('below 5 uses per side there is no verdict, only the note about not enough data', async ($, on) => {
  const AT = NOW - 10 * DAY
  skillWorld(on, {
    ...many('commit', AT - DAY, 5, 0, 'v'),
    ...many('commit', AT + DAY, 1, 3, 'n'),
    [`/h/.claude/maestro/skills/changes/1-commit.json`]: { skill: 'commit', backup: BACKUP, time: AT },
  })
  await $.session.start(START)
  const [a] = await readChanges($)
  expect(a.trend).toBeNull()
  expect(a.note).toContain('not enough data')
})

test('running sessions do not count, two changes split the time', async ($, on) => {
  const A1 = NOW - 20 * DAY
  const A2 = NOW - 10 * DAY
  skillWorld(on, {
    ...many('commit', A1 - DAY, 5, 0, 'a'),
    ...many('commit', A1 + DAY, 5, 0, 'b'),
    ...many('commit', A2 + DAY, 5, 0, 'c'),
    ...used('running', 'commit', A2 + 2 * DAY, 'running'),
    [`/h/.claude/maestro/skills/changes/1-commit.json`]: { skill: 'commit', backup: BACKUP, time: A1 },
    [`/h/.claude/maestro/skills/changes/2-commit.json`]: { skill: 'commit', backup: `${BACKUP}b`, time: A2 },
  })
  await $.session.start(START)
  const list = await readChanges($)
  expect(list.map((a: any) => [a.before.uses, a.after.uses])).toEqual([[5, 5], [5, 5]])
  expect(list[1].trend).toBe('same')
})

test('without changes the list is empty', async ($, on) => {
  skillWorld(on)
  await $.session.start(START)
  expect(await readChanges($)).toEqual([])
})

// --- 7. Approval cards ---

const APPROVAL = { hook_event_name: 'PermissionRequest', session_id: ID, transcript_path: '/t', cwd: '/', tool_name: 'Bash', tool_input: {} }

test('an approval card makes ❓, after the answer the session carries on', async ($, on) => {
  const w = world(on, { role: 'worker' })
  let stateDuringCall: any
  w.toolAnswer = async () => {
    await $.classic.PermissionRequest(APPROVAL as any)
    stateDuringCall = JSON.parse(w.files[STATUS()])
    return { result: {} }
  }
  await $.session.start(START)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  expect(stateDuringCall).toMatchObject({ state: 'waiting', note: 'waiting for your approval', blocked: false })
  expect(JSON.parse(w.files[STATUS()])).toMatchObject({ state: 'working', note: '' })
})

test('if a settings hook answered the question, nobody waits', async ($, on) => {
  const w = world(on, { role: 'worker' })
  w.approvalAnswer = { decision: { behavior: 'allow' } }
  await $.session.start(START)
  await message($, 'go')
  await $.classic.PermissionRequest(APPROVAL as any)
  expect(JSON.parse(w.files[STATUS()]).state).toBe('working')
})

test('the card of a subagent does not change the status', async ($, on) => {
  const w = world(on, { role: 'worker' })
  await $.session.start(START)
  await message($, 'go')
  await $.classic.PermissionRequest({ ...APPROVAL, agent_id: 'a1' } as any)
  expect(JSON.parse(w.files[STATUS()]).state).toBe('working')
})

// --- Recognizing after a restart: new session id, same host id ---

const NEW = 'cccccccc-0000-4000-8000-000000000000'
const OLD = 'dddddddd-0000-4000-8000-000000000000'
const HOST = 'local_11111111'
const ENV = { CLAUDE_CODE_HOST_SESSION_ID: HOST }
const USAGE = (id: string) => `/h/.claude/maestro/skills/usage/${id}.json`
const openWith = (text: string) => ({ items: [{ id: 'p1', text, kind: 'idea', source: 'chat', time: 1, status: 'open' }] })

function oldMaster(w: World, extra: object = {}) {
  w.store[`master:${CODE}`] = { code: CODE, sessionId: OLD, since: 'x', project: 'Music', ...extra }
  w.sessionId = NEW
}
function oldRole(w: World, extra: object = {}) {
  delete w.store[`role:${ID}`]
  w.store[`role:${OLD}`] = { name: 'build', code: CODE, ...extra }
  w.sessionId = NEW
}

test('a master with a new id and the same host id is recognized: band, project, open items stay', async ($, on) => {
  const w = world(on, { env: ENV, files: {
    [OPEN]: openWith('Check dark mode'),
    [STATUS(CODE, OLD)]: { ...statusFile('Maestro', 'ended', [{ text: 'Plan', status: 'in_progress' }]), isMaster: true },
    [STATUS(CODE, 'worker')]: statusFile('build', 'working', [{ text: 'X', status: 'in_progress' }]),
  } })
  oldMaster(w, { hostId: HOST })
  await $.session.start(START)

  expect(w.store[`master:${CODE}`]).toEqual({ code: CODE, sessionId: NEW, since: 'x', project: 'Music', hostId: HOST })
  const text = await readBand($)
  expect(text).toContain('🎼 Music')
  expect(text).toContain('📌 1')
  expect(text).toContain('🔄 build')
  expect(JSON.parse(await callTool($, 'status'))).toMatchObject({ isMaster: true, code: CODE, openItems: 1 })

  await message($, 'go on')
  expect(w.contexts[0]?.join('\n')).toContain('Check dark mode')
  expect(JSON.parse(w.files[STATUS(CODE, NEW)]).steps[0].text).toBe('Plan')
  expect(JSON.parse(w.files[STATUS(CODE, OLD)]).state).toBe('ended')
})

test('an old master entry without a host id is healed via the extra file and gets one', async ($, on) => {
  const w = world(on, { env: ENV, files: { [OPEN]: openWith('x'), [EXTRA(OLD)]: { paths: [], hostId: HOST } } })
  oldMaster(w)
  await $.session.start(START)
  expect(w.store[`master:${CODE}`]).toMatchObject({ sessionId: NEW, hostId: HOST, project: 'Music' })
  expect(await readBand($)).toContain('📌 1')
})

test('master_start does not create a new code after a restart', async ($, on) => {
  const w = world(on, { env: ENV, files: { [EXTRA(OLD)]: { paths: [], hostId: HOST } } })
  oldMaster(w)
  expect(await callTool($, 'master_start')).toContain(`Code: ${CODE}`)
  expect(Object.keys(w.store).filter(k => k.startsWith('master:'))).toEqual([`master:${CODE}`])
})

test('prompt.submit also heals when no session.start came, and starts the band', async ($, on) => {
  const w = world(on, { env: ENV, files: { [OPEN]: openWith('Check dark mode') } })
  oldMaster(w, { hostId: HOST })
  await message($, 'go on')
  expect((w.store[`master:${CODE}`] as any).sessionId).toBe(NEW)
  expect(w.contexts[0]?.join('\n')).toContain('Check dark mode')
  expect(await readBand($)).toContain('🎼 Music')
})

test('a worker session with a new id takes over role, list, skills and paths and appears only once in the band', async ($, on) => {
  const w = world(on, { env: ENV, role: 'worker', files: {
    [STATUS(CODE, OLD)]: statusFile('build', 'ended', [{ text: 'One', status: 'in_progress' }], '', NOW - 1000, { assigned: ['commit'] }),
    [EXTRA(OLD)]: { paths: ['/p/a.ts'], hostId: HOST },
    [USAGE(OLD)]: { sessionId: OLD, code: CODE, name: 'build', task: 'Build mod', assigned: ['commit'], loaded: [{ skill: 'commit', time: 5 }], result: 'running', last: 5 },
    [`/h/.claude/maestro/checked/${CODE}.json`]: { [OLD]: 7, other: 8 },
  } })
  oldRole(w, { hostId: HOST })
  await $.session.start(START)

  expect(w.store[`role:${NEW}`]).toEqual({ name: 'build', code: CODE, hostId: HOST })
  expect(w.store[`role:${OLD}`]).toBeUndefined()
  expect(JSON.parse(w.files[STATUS(CODE, OLD)]).state).toBe('ended')
  expect(JSON.parse(w.files[STATUS(CODE, NEW)])).toMatchObject({ name: 'build', state: 'done', assigned: ['commit'], loaded: ['commit'] })
  expect(JSON.parse(w.files[EXTRA(NEW)])).toEqual({ paths: ['/p/a.ts'], hostId: HOST })
  expect(JSON.parse(w.files[EXTRA(OLD)]).paths).toEqual([])
  expect(JSON.parse(w.files[`/h/.claude/maestro/checked/${CODE}.json`])).toEqual({ [NEW]: 7, other: 8 })

  // The log does not count twice.
  expect(JSON.parse(w.files[USAGE(NEW)])).toMatchObject({ sessionId: NEW, task: 'Build mod', loaded: [{ skill: 'commit', time: 5 }] })
  expect(JSON.parse(w.files[USAGE(OLD)])).toMatchObject({ task: '', loaded: [] })

  // From a master's point of view it appears exactly once.
  w.store[`master:${CODE}`] = { code: CODE, sessionId: NEW, since: 'x' }
  await callTool($, 'master_name', { project: 'x' })
  const rows = (await readBand($)).split('\n').filter(z => z.includes(' build'))
  expect(rows).toHaveLength(1)
})

test('an old role without a host id is healed via the extra file', async ($, on) => {
  const w = world(on, { env: ENV, role: 'worker', files: { [EXTRA(OLD)]: { paths: [], hostId: HOST } } })
  oldRole(w)
  await $.session.start(START)
  expect(w.store[`role:${NEW}`]).toEqual({ name: 'build', code: CODE, hostId: HOST })
})

test('a list that already exists under the new id is not overwritten', async ($, on) => {
  const w = world(on, { env: ENV, role: 'worker', files: {
    [STATUS(CODE, OLD)]: statusFile('build', 'ended', [{ text: 'Old', status: 'in_progress' }]),
    [STATUS(CODE, NEW)]: statusFile('build', 'done', [{ text: 'New', status: 'in_progress' }]),
  } })
  oldRole(w, { hostId: HOST })
  await $.session.start(START)
  expect(JSON.parse(w.files[STATUS(CODE, NEW)]).steps[0].text).toBe('New')
})

test('a foreign host id takes over nothing, neither from the store nor from the extra file', async ($, on) => {
  const w = world(on, { env: ENV, role: 'free', files: {
    [OPEN]: openWith('x'),
    [STATUS(CODE, OLD)]: statusFile('Maestro', 'ended'),
    [EXTRA(OLD)]: { paths: [], hostId: 'local_foreign' },
    [EXTRA('other')]: { paths: [], hostId: 'local_foreign' },
  } })
  w.store[`master:${CODE}`] = { code: CODE, sessionId: OLD, since: 'x' }
  w.store[`master:bbbbbbbb`] = { code: 'bbbbbbbb', sessionId: 'x', since: 'x', hostId: 'local_foreign' }
  w.store[`role:other`] = { name: 'build', code: CODE }
  w.sessionId = NEW
  await $.session.start(START)
  expect(w.store[`master:${CODE}`]).toEqual({ code: CODE, sessionId: OLD, since: 'x' })
  expect(w.store[`role:${NEW}`]).toBeUndefined()
  expect(JSON.parse(await callTool($, 'status')).isMaster).toBe(false)
  expect(JSON.parse(w.files[STATUS(CODE, OLD)]).state).toBe('ended')
  expect(w.files[STATUS(CODE, NEW)]).toBeUndefined()
})

test('the role of an ended Maestro is not taken over', async ($, on) => {
  const w = world(on, { env: ENV, role: 'free' })
  w.store[`role:${OLD}`] = { name: 'build', code: 'gone', hostId: HOST }
  w.sessionId = NEW
  await $.session.start(START)
  expect(w.store[`role:${NEW}`]).toBeUndefined()
})

test('without a host id everything stays as before, without errors', async ($, on) => {
  const w = world(on, { files: { [EXTRA(OLD)]: { paths: [], hostId: HOST } } })
  oldMaster(w)
  await $.session.start(START)
  await message($, 'hello')
  expect((w.store[`master:${CODE}`] as any).sessionId).toBe(OLD)
  expect(JSON.parse(await callTool($, 'status')).isMaster).toBe(false)
})

test('master_start and a task store the host id, an existing entry gets it added', async ($, on) => {
  const w = world(on, { env: ENV, role: 'free' })
  await callTool($, 'master_start')
  expect(w.store[`master:${ID.slice(0, 8)}`]).toMatchObject({ sessionId: ID, hostId: HOST })

  delete w.store[`master:${ID.slice(0, 8)}`]
  w.store[`master:${CODE}`] = { code: CODE, sessionId: 'other', since: 'x' }
  await message($, `⟦maestro:build＠${CODE}⟧ Brief\nTask: One`)
  expect(w.store[`role:${ID}`]).toEqual({ name: 'build', code: CODE, hostId: HOST })

  w.store[`role:${ID}`] = { name: 'build', code: CODE }
  await $.session.start(START)
  expect(w.store[`role:${ID}`]).toEqual({ name: 'build', code: CODE, hostId: HOST })
})

test('/clear on the master with a host id runs as before: reminder, same code, no duplicate row', async ($, on) => {
  const w = world(on, { env: ENV, files: { [OPEN]: openWith('Check dark mode') } })
  await $.session.start(START)
  await $.session.end({ reason: 'clear', sessionId: ID, resume: {} } as any)
  w.sessionId = NEW
  await message($, 'go on')
  const context = w.contexts[0]?.join('\n')
  expect(context).toContain('handoff-aaaaaaaa')
  expect(context).toContain('Check dark mode')
  expect(w.store[`master:${CODE}`]).toMatchObject({ sessionId: NEW, hostId: HOST })
  expect(JSON.parse(w.files[STATUS(CODE, ID)]).state).toBe('ended')
})

test('/clear on a worker session does not bring back the old status', async ($, on) => {
  const w = world(on, { env: ENV, role: 'worker' })
  await $.session.start(START)
  await message($, `⟦maestro:build＠${CODE}⟧ Brief\nTask: One`)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [{ content: 'Old', status: 'in_progress' }] } as any)
  await $.session.end({ reason: 'clear', sessionId: ID, resume: {} } as any)
  w.sessionId = NEW
  await message($, 'something else')
  expect(w.store[`role:${NEW}`]).toBeUndefined()
  expect(w.files[STATUS(CODE, NEW)]).toBeUndefined()
  expect(JSON.parse(w.files[STATUS(CODE, ID)]).state).toBe('ended')
})

// --- Robustness ---

test('without any file system a message still gets through', async ($, on) => {
  const seen: string[] = []
  on('session.id', () => ({ value: ID }))
  on('store.keys', () => ({ value: [`master:${CODE}`] }))
  on('store.get', () => ({ value: { code: CODE, sessionId: ID, since: 'x' } }))
  on('env.get', () => ({ value: '/h' }))
  on('clock.now', () => ({ value: NOW }))
  on('fs.exists', () => {
    throw new Error('broken')
  })
  on('fs.read', () => {
    throw new Error('broken')
  })
  on('fs.write', () => {
    throw new Error('broken')
  })
  on('prompt.submit', (_: any, e: any) => {
    seen.push(e.text)
    return { text: e.text }
  })
  await message($, 'hello')
  expect(seen).toEqual(['hello'])
})

// --- The mod sets the marker itself ---

const TARGET = 'local_11111111-2222-4333-8444-555555555555'

test('a master task gets the marker, even if the master forgets it', async ($, on) => {
  const w = world(on)
  w.toolAnswer = () => ({ result: { content: [{ type: 'text', text: `Started session "Run A" (session_id: ${TARGET}, name: run2-a).` }] } })
  await $.tool.call({ tool: 'mcp__ccd_session__start_session', name: 'run2-a', title: 'Run A', prompt: 'Build piece 1.' } as any)
  expect(w.toolIn.at(-1).prompt).toBe(`⟦maestro:run2-a@${CODE}⟧ Build piece 1.`)
  expect(w.store[`target:${TARGET}`]).toEqual({ name: 'run2-a', code: CODE })

  w.toolAnswer = () => ({ result: {} })
  await $.tool.call({ tool: 'SendMessage', to: TARGET, message: 'Round 2.' } as any)
  expect(w.toolIn.at(-1).message).toBe(`⟦maestro:run2-a@${CODE}⟧ Round 2.`)
})

test('an existing marker stays, without a name the title helps', async ($, on) => {
  const w = world(on)
  const withMarker = `⟦maestro:own@${CODE}⟧ Go.`
  await $.tool.call({ tool: 'mcp__ccd_session__start_session', name: 'x', prompt: withMarker } as any)
  expect(w.toolIn.at(-1).prompt).toBe(withMarker)
  // German umlauts in a title are transliterated.
  await $.tool.call({ tool: 'mcp__ccd_session__start_session', title: 'Größe prüfen: Runde 3', prompt: 'Go.' } as any)
  expect(w.toolIn.at(-1).prompt).toBe(`⟦maestro:groesse-pruefen-runde-3@${CODE}⟧ Go.`)
})

test('messages to foreign sessions and tasks of other sessions stay unchanged', async ($, on) => {
  const w = world(on)
  await $.tool.call({ tool: 'SendMessage', to: 'local_99999999-2222-4333-8444-555555555555', message: 'Hello.' } as any)
  expect(w.toolIn.at(-1).message).toBe('Hello.')
  await $.tool.call({ tool: 'SendMessage', to: 'helper', message: 'Hello.' } as any)
  expect(w.toolIn.at(-1).message).toBe('Hello.')
})

test('a worker session sets no marker', async ($, on) => {
  const w = world(on, { role: 'worker' })
  await $.tool.call({ tool: 'mcp__ccd_session__start_session', name: 'helper', prompt: 'Go.' } as any)
  expect(w.toolIn.at(-1).prompt).toBe('Go.')
})

test('a follow-up message to a signed-in worker session gets its name', async ($, on) => {
  const w = world(on)
  w.store['role:bbbbbbbb-0000-4000-8000-000000000000'] = { name: 'manual', code: CODE, hostId: TARGET }
  await $.tool.call({ tool: 'SendMessage', to: TARGET, message: 'Go on.' } as any)
  expect(w.toolIn.at(-1).message).toBe(`⟦maestro:manual@${CODE}⟧ Go on.`)
})

test('the master is reminded of the skill once, not any more after loading', async ($, on) => {
  const w = world(on)
  await message($, 'one')
  await message($, 'two')
  expect(w.contexts[0]?.join('\n')).toContain('load it now')
  expect(w.contexts[1]?.join('\n') ?? '').not.toContain('load it now')
})

test('if the skill is already loaded, the mod does not remind', async ($, on) => {
  const w = world(on)
  await $.skill.prompt({ skill: 'maestro', text: '' })
  await message($, 'one')
  expect(w.contexts[0]?.join('\n') ?? '').not.toContain('load it now')
})
