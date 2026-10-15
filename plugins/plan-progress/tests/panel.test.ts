import { expect, mock, test } from 'claude-code/testing'

const SCROLL = { offset: 0, bodyRows: 40 }
// a bar's drawing, not a state glyph (alt 狀態：…), a colour dot (顏色：…), the grey behind the fold button (收合：…) or a spacer (間距：…)
const isBarAlt = (a: unknown) => a !== '' && !['狀態：', '顏色：', '收合：', '間距：'].some(p => String(a).startsWith(p))

// the engine's own answers beneath the plugin: a fixed clock, an in-memory store, an empty drawing
function engine(on: any, opts: { clock?: boolean; saved?: Record<string, unknown>; theme?: string } = {}) {
  // what earlier sessions saved
  const store = new Map<string, unknown>(Object.entries(opts.saved ?? {}))
  const played: string[] = []
  const closed: string[] = []
  const opened: string[] = []
  const toasts: string[] = []
  // calls on $ answer { value }; events (ui.render, command.run) answer their result
  if (opts.clock !== false) {
    on('clock.now', () => ({ value: 1_790_000_000_000 }))
    on('clock.every', () => ({ value: undefined }))
    on('clock.after', () => ({ value: undefined }))
  }
  // the /config rows the plugin reads: the theme, light unless a test says otherwise
  on('config.list', () => ({ value: [{ key: 'theme', value: opts.theme ?? 'light' }] }))
  on('store.get', (_$: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', (_$: unknown, e: { key: string; value: unknown }) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }))
  on('ui.open', (_$: unknown, e: { id: string }) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$: unknown, e: { id: string }) => {
    closed.push(e.id)
    return { value: undefined }
  })
  on('ui.toast', (_$: unknown, e: { text: string }) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('command.run', () => ({ text: '' }))
  on('audio.play', (_$: unknown, e: { clip: { asset?: string } }) => {
    played.push(String(e.clip.asset))
    return { value: undefined }
  })
  on('prompt.submit', (_$: unknown, e: { text: string }) => ({ text: e.text }))
  return { store, closed, opened, toasts, played }
}
const PANE = 'plan-progress-styles'
const STYLES = ['segments', 'hairline', 'beads', 'ledger', 'transit', 'grid', 'original']

for (const surface of ['desktop', 'terminal'] as const) {
  test(`${surface}: the gear sits at the band's top right, not in the footer, and opens the style pane`, async ($, on) => {
    const host = engine(on)
    // the desktop app (2.37337) gives a plugin's footer labels a row of their own: the footer draws no gear
    const footer = await $.ui.mount({ plugin: 'plan-progress', surface, component: 'SessionMode', props: { modes: [] } as never })
    expect(await footer.find({ key: 'progress-style' })).toBeUndefined()
    await $.command.run({ command: 'progress-demo' })
    const props = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: SCROLL }
    const above = await $.ui.mount({ plugin: 'plan-progress', surface, component: 'AbovePrompt', props: props as never })
    // its own column beside the rows, at the top, so it takes no row of height
    const column = await above.find({ key: 'band-gear' })
    expect(column?.props.width).toBe(3)
    expect((await above.drawn()).props.flexDirection).toBe('row')
    expect((await above.find({ key: 'progress-style' }))?.text).toBe('\u2699\uFE0E')
    await above.press({ key: 'progress-style' })
    expect(host.opened).toEqual([PANE])
  })

  test(`${surface}: the pane shows and hides the bars`, async ($, on) => {
    engine(on)
    await $.command.run({ command: 'progress-demo' })
    const props = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: SCROLL }
    const bars = async () => {
      const above = await $.ui.mount({ plugin: 'plan-progress', surface: 'desktop', component: 'AbovePrompt', props: props as never })
      // the bars, not the state glyphs beside them (drawn with no alt)
      const n = (await above.findAll({ type: 'Svg' })).filter((el: any) => isBarAlt(el.props.alt)).length
      await above.unmount()
      return n
    }
    const paneProps = { title: '進度條樣式', isFocused: true, bodyColumns: 50, placement: 'dock', scroll: SCROLL }
    const ui = await $.ui.mount({ plugin: 'plan-progress', surface, component: 'Pane', requestId: PANE, props: paneProps as never })
    expect((await ui.find({ key: 'bars-shown' }))?.props.variant).toBe('primary')
    expect(await bars()).toBe(1)
    await ui.press({ key: 'bars-hidden' })
    expect(await bars()).toBe(0)
    expect((await ui.find({ key: 'bars-hidden' }))?.props.variant).toBe('primary')
    await ui.press({ key: 'bars-shown' })
    expect(await bars()).toBe(1)
  })

  test(`${surface}: the pane lists every style and a press switches it`, async ($, on) => {
    engine(on)
    const props = { title: '進度條樣式', isFocused: true, bodyColumns: 50, placement: 'dock', scroll: SCROLL }
    const ui = await $.ui.mount({ plugin: 'plan-progress', surface, component: 'Pane', requestId: PANE, props: props as never })
    for (const id of STYLES) expect(await ui.find({ key: `use-${id}` })).toBeDefined()
    expect((await ui.find({ key: 'use-segments' }))?.text).toBe('✓ 使用中')
    await ui.press({ key: 'use-beads' })
    expect((await ui.find({ key: 'use-beads' }))?.text).toBe('✓ 使用中')
    expect((await ui.find({ key: 'use-segments' }))?.text).toBe('使用')
  })

  test(`${surface}: save and close keeps the choice and closes the pane`, async ($, on) => {
    const host = engine(on)
    const props = { title: '進度條樣式', isFocused: true, bodyColumns: 50, placement: 'dock', scroll: SCROLL }
    const ui = await $.ui.mount({ plugin: 'plan-progress', surface, component: 'Pane', requestId: PANE, props: props as never })
    await ui.press({ key: 'use-transit' })
    await ui.press({ key: 'agents-summary' })
    expect((await ui.find({ key: 'save-close' }))?.text).toBe('儲存並關閉')
    // the top row holds 進度條 and 提示音 side by side, then a spacer that pushes save and close to the right edge
    const row = (await ui.find({ key: 'settings-row' }))?.children as { key?: string; type?: string; props?: Record<string, unknown> }[]
    expect(row.map(c => (c.props?.key as string | undefined) ?? c.key ?? c.type)).toEqual(['Box', 'Box', 'Box', 'save-close'])
    expect(row[2]?.props?.flexGrow).toBe(1)
    const top = JSON.stringify(row)
    for (const key of ['bars-shown', 'bars-hidden', 'sounds-on', 'sounds-off']) expect(top).toContain(key)
    expect((await ui.findAll({ key: 'save-close' })).length).toBe(1)
    await ui.press({ key: 'save-close' })
    expect(host.closed).toEqual([PANE])
    expect(host.store.get('style')).toBe('transit')
    expect(host.store.get('agentView')).toBe('summary')
  })

  test(`${surface}: the pane switches how subagents show`, async ($, on) => {
    engine(on)
    const props = { title: '進度條樣式', isFocused: true, bodyColumns: 50, placement: 'dock', scroll: SCROLL }
    const ui = await $.ui.mount({ plugin: 'plan-progress', surface, component: 'Pane', requestId: PANE, props: props as never })
    for (const k of ['expanded', 'summary', 'hidden']) expect(await ui.find({ key: `agents-${k}` })).toBeDefined()
    const tree = async () => JSON.stringify(await ui.drawn())
    // the pane stays bare: names, buttons and previews, no explanations
    expect(await tree()).not.toContain('像捷運圖')
    expect(await tree()).not.toContain('下次開 session')
    if (surface === 'desktop') expect(await tree()).toContain('比對打包大小')
    await ui.press({ key: 'agents-summary' })
    if (surface === 'desktop') {
      // the preview folds three runs into one line that counts them
      expect(await tree()).toContain('3 subagents')
      expect(await tree()).toContain('1 running · 1 waiting · 1 done')
      expect(await tree()).not.toContain('比對打包大小')
    }
    await ui.press({ key: 'agents-hidden' })
    if (surface === 'desktop') {
      expect(await tree()).not.toContain('3 subagents')
      expect(await tree()).not.toContain('比對打包大小')
    }
  })
}

test('desktop: every style tile and preview has one size, and switching subagent modes keeps the height', async ($, on) => {
  engine(on)
  const props = { title: '進度條樣式', isFocused: true, bodyColumns: 50, placement: 'dock', scroll: SCROLL }
  const ui = await $.ui.mount({ plugin: 'plan-progress', surface: 'desktop', component: 'Pane', requestId: PANE, props: props as never })
  // Svg carries no key: in document order the first is the subagent preview, the next six the style previews
  const svgSizes = async () => (await ui.findAll({ type: 'Svg' })).map(el => `${el.props.width}x${el.props.height}`)
  // tiles stretch to the pane's width instead of naming one: a Box width counts cells, so a pixel figure there
  // made each tile ~3000px wide and pushed its 使用 button out of sight (0.5.3)
  expect((await ui.find({ key: 'style-list' }))?.props.alignItems).toBe('stretch')
  for (const id of STYLES) {
    const tile = await ui.find({ key: `style-${id}` })
    expect(tile).toBeDefined()
    expect(tile?.props.width).toBeUndefined()
  }
  // the colour row's dots are Svgs too: the style previews are the ones named "<style> preview"
  const previews = (await ui.findAll({ type: 'Svg' })).filter(el => STYLES.some(id => el.props.alt === `${id} preview`)).map(el => `${el.props.width}x${el.props.height}`)
  expect(previews.length).toBe(STYLES.length)
  expect(new Set(previews).size).toBe(1)
  expect(previews[0]).not.toContain('undefined')
  const heights: string[] = []
  for (const k of ['expanded', 'summary', 'hidden']) {
    await ui.press({ key: `agents-${k}` })
    heights.push((await svgSizes())[0] ?? 'missing')
  }
  expect(new Set(heights).size).toBe(1)
})

test('desktop: every style draws the bar above the prompt', async ($, on) => {
    engine(on)
  await $.command.run({ command: 'progress-demo' })
  const props = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: SCROLL }
  for (const id of STYLES) {
    const answer = await $.command.run({ command: 'progress-style', args: id })
    expect(JSON.stringify(answer)).toContain(id)
    const ui = await $.ui.mount({ plugin: 'plan-progress', surface: 'desktop', component: 'AbovePrompt', props: props as never })
    const svg = (await ui.findAll({ type: 'Svg' })).filter((el: any) => isBarAlt(el.props.alt))
    expect(svg.length).toBe(1)
    // the ⚙ lives in the footer only, not on the bar row
    expect(await ui.find({ key: 'style-demo' })).toBeUndefined()
    // counts read like 5/16, never zero-padded
    expect(JSON.stringify(await ui.drawn())).not.toMatch(/"0\d\/\d+"/)
    // a stage name beside the bar is medium, not bold, so it does not outweigh the title
    expect(String(svg[0]?.props.source)).not.toContain('<tspan font-weight="600"')
    await ui.unmount()
  }
})

test('/progress-style rejects an unknown name and cycles with next', async ($, on) => {
    engine(on)
  expect(JSON.stringify(await $.command.run({ command: 'progress-style', args: 'nope' }))).toContain('沒有')
  expect(JSON.stringify(await $.command.run({ command: 'progress-style', args: 'next' }))).toContain('已切換到 hairline')
})

test('the person\'s next message fades finished bars out, then removes them; running bars stay', async ($, on) => {
  engine(on, { clock: false })
  const clock = mock.clock(on, { now: 1_790_000_000_000 })
  const TOOL = 'mcp__plan-progress__plan_progress'
  const stages = [{ name: 'Build', steps: [{ title: 'one', status: 'active' }, { title: 'two', status: 'pending' }] }]
  await $.tool.call({ tool: TOOL, id: 'finished', title: 'finished', stages } as never)
  await $.tool.call({ tool: TOOL, id: 'finished', state: 'done' } as never)
  await $.tool.call({ tool: TOOL, id: 'working', title: 'working', stages } as never)
  const props = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: SCROLL }
  const look = async () => {
    const above = await $.ui.mount({ plugin: 'plan-progress', surface: 'desktop', component: 'AbovePrompt', props: props as never })
    const tree = JSON.stringify(await above.drawn())
    // bar drawings only: the hairline divider between two bars is an Svg with an empty alt
    const rows = (await above.findAll({ type: 'Svg' })).filter(el => isBarAlt(el.props.alt)).map(el => String(el.props.source).includes('pp-leave'))
    await above.unmount()
    return { tree, rows }
  }
  expect((await look()).rows).toEqual([false, false])
  await $.prompt.submit({ text: 'next task', asUser: true })
  // the finished bar fades, the running one does not
  const fading = await look()
  expect(fading.rows).toEqual([true, false])
  await clock.advance(450)
  const after = await look()
  expect(after.rows).toEqual([false])
  expect(after.tree).toContain('working')
  expect(after.tree).not.toContain('"finished"')
})

const TOOL = 'mcp__plan-progress__plan_progress'
const STAGES = [{ name: 'Build', steps: [{ title: 'one', status: 'active' }, { title: 'two', status: 'pending' }] }]
const ABOVE = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: SCROLL }
const PANE_PROPS = { title: '進度條樣式', isFocused: true, bodyColumns: 50, placement: 'dock', scroll: SCROLL }
const barCount = async ($: any) => {
  const above = await $.ui.mount({ plugin: 'plan-progress', surface: 'desktop', component: 'AbovePrompt', props: ABOVE as never })
  const n = (await above.findAll({ type: 'Svg' })).filter((el: any) => isBarAlt(el.props.alt)).length
  await above.unmount()
  return n
}

test('hidden bars stay hidden when a new bar starts, and the choice is saved', async ($, on) => {
  const host = engine(on)
  await $.tool.call({ tool: TOOL, id: 'first', title: 'first', stages: STAGES } as never)
  const pane = await $.ui.mount({ plugin: 'plan-progress', surface: 'desktop', component: 'Pane', requestId: PANE, props: PANE_PROPS as never })
  await pane.press({ key: 'bars-hidden' })
  expect(host.store.get('isOpen')).toBe(false)
  // a new task used to show the bars again; now only the person does
  await $.tool.call({ tool: TOOL, id: 'second', title: 'second', stages: STAGES } as never)
  expect(await barCount($)).toBe(0)
  await pane.press({ key: 'bars-shown' })
  expect(host.store.get('isOpen')).toBe(true)
  expect(await barCount($)).toBe(2)
})

test('a session starts with the bars hidden and sounds off when an earlier one saved that', async ($, on) => {
  const host = engine(on, { saved: { isOpen: false, sounds: false } })
  // a new session reads what the last one saved; the test stands for the engine beneath the plugin
  on('session.start', () => ({ cwd: '/tmp' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: TOOL, id: 'first', title: 'first', stages: STAGES } as never)
  expect(await barCount($)).toBe(0)
  const pane = await $.ui.mount({ plugin: 'plan-progress', surface: 'desktop', component: 'Pane', requestId: PANE, props: PANE_PROPS as never })
  expect((await pane.find({ key: 'bars-hidden' }))?.props.variant).toBe('primary')
  expect((await pane.find({ key: 'sounds-off' }))?.props.variant).toBe('primary')
  await $.tool.call({ tool: TOOL, id: 'first', state: 'done' } as never)
  expect(host.played).toEqual([])
})

test('sounds play by default, the pane turns them off and on, and the choice is saved', async ($, on) => {
  const host = engine(on)
  const pane = await $.ui.mount({ plugin: 'plan-progress', surface: 'desktop', component: 'Pane', requestId: PANE, props: PANE_PROPS as never })
  expect((await pane.find({ key: 'sounds-on' }))?.props.variant).toBe('primary')
  await $.tool.call({ tool: TOOL, id: 'a', title: 'a', stages: STAGES } as never)
  await $.tool.call({ tool: TOOL, id: 'a', state: 'done' } as never)
  expect(host.played).toEqual(['sounds/done.wav'])
  await pane.press({ key: 'sounds-off' })
  expect(host.store.get('sounds')).toBe(false)
  await $.tool.call({ tool: TOOL, id: 'b', title: 'b', stages: STAGES } as never)
  await $.tool.call({ tool: TOOL, id: 'b', state: 'error', note: 'x' } as never)
  expect(host.played).toEqual(['sounds/done.wav'])
  await pane.press({ key: 'sounds-on' })
  expect(host.store.get('sounds')).toBe(true)
  await $.tool.call({ tool: TOOL, id: 'b', state: 'done' } as never)
  expect(host.played).toEqual(['sounds/done.wav', 'sounds/done.wav'])
})

// one main-loop turn as a session raises it: turn.start, then the model's calls, then turn.complete
function turns(on: any) {
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.Stop', () => ({}))
}
const END = { answer: 'report', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const
const barAlt = async ($: any) => {
  const above = await $.ui.mount({ plugin: 'plan-progress', surface: 'desktop', component: 'AbovePrompt', props: ABOVE as never })
  const alts = (await above.findAll({ type: 'Svg' })).filter((el: any) => isBarAlt(el.props.alt)).map((el: any) => String(el.props.alt))
  await above.unmount()
  return alts
}

test('a bar finished mid-turn turns done and sounds only when the main turn ends, after the reply', async ($, on) => {
  const host = engine(on)
  turns(on)
  await $.turn.start({ text: 'do it', turnId: 't1' })
  await $.tool.call({ tool: TOOL, id: 'a', title: 'a', stages: STAGES } as never)
  const answer = await $.tool.call({ tool: TOOL, id: 'a', next: true } as never)
  await $.tool.call({ tool: TOOL, id: 'a', next: true } as never)
  // the model is told done, so it does not send it again
  expect(JSON.stringify(answer)).not.toContain('error')
  expect(host.played).toEqual([])
  expect((await barAlt($))[0]).not.toContain(': done')
  // a subagent's turn ending is not the main turn ending
  await $.turn.complete({ ...END, agentId: 'sub-1', turnId: 't2' } as never)
  expect(host.played).toEqual([])
  // the end-of-turn check does not send the model back over a bar it already finished
  const stop = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'report' } as never)
  expect((stop as { block?: string }).block).toBeUndefined()
  await $.turn.complete(END as never)
  expect(host.played).toEqual(['sounds/done.wav'])
  expect((await barAlt($))[0]).toContain(': done')
})

test('an explicit done mid-turn waits the same way', async ($, on) => {
  const host = engine(on)
  turns(on)
  await $.turn.start({ text: 'do it', turnId: 't1' })
  await $.tool.call({ tool: TOOL, id: 'a', title: 'a', stages: STAGES } as never)
  const answer = await $.tool.call({ tool: TOOL, id: 'a', state: 'done' } as never)
  expect(JSON.stringify(answer)).toContain('done')
  expect(host.played).toEqual([])
  // its steps are not all ticked, yet the end-of-turn check leaves it alone
  const stop = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'report' } as never)
  expect((stop as { block?: string }).block).toBeUndefined()
  await $.turn.complete(END as never)
  expect(host.played).toEqual(['sounds/done.wav'])
  expect((await barAlt($))[0]).toContain(': done')
})

test('subagents finishing mid-turn sound done once, when the main turn ends', async ($, on) => {
  const host = engine(on)
  turns(on)
  let n = 0
  on('agent.spawn', () => ({ agentId: `sub-${++n}`, model: 'haiku' }))
  await $.turn.start({ text: 'research', turnId: 't1' })
  const spawn = { tool_use_id: 'u', prompt: 'p', description: 'look around', subagentType: 'Explore', provider: { kind: 'model' }, parentModel: 'opus', background: false, fork: false }
  await $.agent.spawn(spawn as never)
  await $.agent.spawn({ ...spawn, tool_use_id: 'u2' } as never)
  await $.turn.complete({ ...END, agentId: 'sub-1', turnId: 's1' } as never)
  await $.turn.complete({ ...END, agentId: 'sub-2', turnId: 's2' } as never)
  // the agents bar is done, but the reply is still being written
  expect(host.played).toEqual([])
  await $.turn.complete(END as never)
  expect(host.played).toEqual(['sounds/done.wav'])
})

// ---------- other sessions ----------
const NOW = 1_790_000_000_000
const ME = 'local_00000000-0000-4000-8000-000000000000'
const sid = (n: number) => `local_00000000-0000-4000-8000-00000000000${n}`
const DIR = '/home/me/.claude/plan-progress/sessions'

// the shared folder in memory, the environment a desktop session sees, and the commands the plugin runs
function hostFs(on: any, env: Record<string, string | undefined> = { HOME: '/home/me', CLAUDE_CODE_HOST_SESSION_ID: ME }) {
  const files = new Map<string, { text: string; mtimeMs: number }>()
  const ran: string[][] = []
  on('env.get', (_$: unknown, e: { name: string }) => ({ value: env[e.name] }))
  on('fs.write', (_$: unknown, e: { path: string; text: string }) => {
    files.set(e.path, { text: e.text, mtimeMs: NOW })
    return { value: undefined }
  })
  on('fs.read', (_$: unknown, e: { path: string }) => {
    const f = files.get(e.path)
    if (!f) throw new Error('missing')
    return { value: f.text }
  })
  // a folder lists its own children: files, and the folders deeper files sit in
  on('fs.list', (_$: unknown, e: { path: string }) => {
    const kids = new Map<string, { name: string; kind: string; size: number; mtimeMs: number; isLink: boolean }>()
    for (const [p, f] of files.entries()) {
      if (!p.startsWith(`${e.path}/`)) continue
      const rest = p.slice(e.path.length + 1)
      const name = rest.split('/')[0] ?? rest
      kids.set(name, rest.includes('/') ? { name, kind: 'dir', size: 0, mtimeMs: f.mtimeMs, isLink: false } : { name, kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false })
    }
    return { value: [...kids.values()] }
  })
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: files.has(e.path) }))
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    ran.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('session.cwd', () => ({ value: '/work/memelab' }))
  on('session.start', () => ({ cwd: '/work/memelab' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  const put = (hostId: string, state: string, since: number, extra: Record<string, unknown> = {}) =>
    files.set(`${DIR}/${hostId}.json`, {
      text: JSON.stringify({ v: 1, hostId, cwd: `/work/${hostId.slice(-1)}-proj`, label: `task ${hostId.slice(-1)}`, state, since, updatedAt: since, ...extra }),
      mtimeMs: since,
    })
  const mine = () => JSON.parse(files.get(`${DIR}/${ME}.json`)?.text ?? 'null')
  return { files, ran, put, mine }
}
const start = ($: any) => $.session.start({ cwd: '/work/memelab', surface: 'desktop', isInteractive: true })
const awayRows = async ($: any) => {
  const above = await $.ui.mount({ plugin: 'plan-progress', surface: 'desktop', component: 'AbovePrompt', props: ABOVE as never })
  const tree = JSON.stringify(await above.drawn())
  const rows = [1, 2, 3, 4, 5, 6, 7, 8].map(sid).filter(id => tree.includes(`away-${id}`))
  return { above, tree, rows }
}

test('a desktop session writes its status for the others: working, done, waiting, ended', async ($, on) => {
  engine(on)
  turns(on)
  on('session.end', () => ({ sessionId: 's1' }))
  const fs = hostFs(on)
  await start($)
  await $.prompt.submit({ text: '幫我修跟單參數', asUser: true })
  await $.turn.start({ text: '幫我修跟單參數', turnId: 't1' })
  expect(fs.mine()).toMatchObject({ v: 1, hostId: ME, cwd: '/work/memelab', state: 'working', label: '幫我修跟單參數' })
  await $.tool.call({ tool: TOOL, id: 'fix', title: '修跟單參數', stages: STAGES } as never)
  await $.turn.complete({ ...END, answer: '改好了。' } as never)
  expect(fs.mine()).toMatchObject({ state: 'done', label: '修跟單參數' })
  await $.turn.start({ text: 'next', turnId: 't2' })
  await $.turn.complete({ ...END, answer: '要部署嗎？', turnId: 't2' } as never)
  expect(fs.mine().state).toBe('needs_input')
  await $.turn.start({ text: 'stop', turnId: 't3' })
  await $.turn.complete({ ...END, reason: 'aborted', isAborted: true, turnId: 't3' } as never)
  expect(fs.mine().state).toBe('idle')
  await $.session.end({ reason: 'other' } as never)
  expect(fs.mine().state).toBe('ended')
})

test('a terminal session has no id to switch to, so it writes nothing', async ($, on) => {
  engine(on)
  turns(on)
  const fs = hostFs(on, { HOME: '/home/me' })
  await start($)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.turn.complete(END as never)
  expect(fs.files.size).toBe(0)
})

test('every other session shows its newest bar; its title switches to it, ✕ hides it until it changes', async ($, on) => {
  engine(on, { clock: false })
  const clock = mock.clock(on, { now: NOW })
  const fs = hostFs(on)
  const doneBar = { id: 'b1', title: '第5批回測', kind: 'plan', stages: [{ name: 'Run', steps: [{ title: 'a', status: 'done' }] }], state: 'done', note: null, startedAt: NOW - 200_000 }
  const workBar = { id: 'b3', title: '修跟賣', kind: 'plan', stages: [{ name: 'Fix', steps: [{ title: 'a', status: 'done' }, { title: 'b', status: 'active' }] }], state: 'running', note: null, startedAt: NOW - 50_000 }
  const agentsBar = { id: 'agents:auto', title: 'Agents', kind: 'todo', stages: [{ name: 'Agents', steps: [{ title: 'x', status: 'active' }] }], state: 'running', note: null, startedAt: NOW - 5_000 }
  fs.put(sid(1), 'done', NOW - 60_000, { bars: [doneBar] })
  fs.put(sid(2), 'needs_input', NOW - 120_000)
  fs.put(sid(3), 'working', NOW - 10_000, { bars: [workBar, agentsBar] })
  fs.put(sid(4), 'working', NOW - 10 * 60_000) // a working file nobody refreshed: that session is gone
  fs.put(sid(5), 'done', NOW - 30_000)
  fs.put(sid(6), 'done', NOW - 25 * 3600_000) // older than a day
  fs.put(sid(7), 'ended', NOW - 5_000)
  fs.put(sid(8), 'working', NOW - 20_000, { bars: [{ id: 'x', title: '<script>', stages: 'nope' }] }) // a bar that does not parse
  fs.put(ME, 'done', NOW - 5_000) // this session itself
  fs.put('evil-session', 'done', NOW - 5_000) // a file whose id is not a desktop session id
  fs.files.set(`${DIR}/seen.json`, { text: JSON.stringify({ [sid(5)]: NOW - 30_000 }), mtimeMs: NOW })
  await start($)
  await clock.advance(2000)
  const { above, tree, rows } = await awayRows($)
  // seen, stale, ended, own and malformed ones left out
  expect(rows).toEqual([sid(1), sid(2), sid(3), sid(8)])
  // waiting on the person first, then finished, then running (newest first)
  const at = (n: number) => tree.indexOf(`away-${sid(n)}`)
  expect(at(2)).toBeLessThan(at(1))
  expect(at(1)).toBeLessThan(at(3))
  expect(at(3)).toBeLessThan(at(8))
  // the newest task bar is drawn, not the subagents' bar; its title is the switch button
  const svgAlts = (await above.findAll({ type: 'Svg' })).map((el: any) => String(el.props.alt))
  expect(svgAlts).toContain('1-proj · 第5批回測: 跑完了')
  expect(svgAlts).toContain('3-proj · 修跟賣: 在跑')
  expect((await above.find({ key: `switch-${sid(3)}` }))?.text).toBe('3-proj · 修跟賣')
  // no bar: the row says what the session does
  expect((await above.find({ key: `switch-${sid(2)}` }))?.text).toBe('2-proj · task 2')
  expect(tree).toContain('等你決定')
  expect(tree).not.toContain('<script>')
  expect(tree).not.toContain('evil')
  expect(tree).not.toContain(`away-${ME}`)
  await above.press({ key: `switch-${sid(1)}` })
  expect(fs.ran).toEqual([['open', `claude://claude.ai/epitaxy/${sid(1)}`]])
  expect(JSON.parse(fs.files.get(`${DIR}/seen.json`)?.text ?? '{}')[sid(1)]).toBe(NOW - 60_000)
  await above.unmount()
  expect((await awayRows($)).rows).toEqual([sid(2), sid(3), sid(8)])
  const again = await awayRows($)
  const label = async (ui: any) => (await ui.find({ key: `switch-${sid(2)}` }))?.props.dimColor
  expect(await label(again.above)).toBeFalsy()
  await again.above.press({ key: `seen-${sid(2)}` })
  await again.above.unmount()
  // ✕ dims the row first, then it leaves; the seen mark is written once it has gone
  const fading = await awayRows($)
  expect(fading.rows).toEqual([sid(2), sid(3), sid(8)])
  expect(await label(fading.above)).toBe(true)
  await fading.above.unmount()
  expect(JSON.parse(fs.files.get(`${DIR}/seen.json`)?.text ?? '{}')[sid(2)]).toBeUndefined()
  await clock.advance(450)
  expect((await awayRows($)).rows).toEqual([sid(3), sid(8)])
  expect(JSON.parse(fs.files.get(`${DIR}/seen.json`)?.text ?? '{}')[sid(2)]).toBe(NOW - 120_000)
  // ✕ only hides: nothing opens
  expect(fs.ran.length).toBe(1)
  // a running session always shows: it has no ✕, and even a seen mark does not hide it
  const third = await awayRows($)
  expect(await third.above.find({ key: `seen-${sid(3)}` })).toBeUndefined()
  await third.above.unmount()
  const marks = JSON.parse(fs.files.get(`${DIR}/seen.json`)?.text ?? '{}')
  fs.files.set(`${DIR}/seen.json`, { text: JSON.stringify({ ...marks, [sid(3)]: NOW }), mtimeMs: NOW })
  await clock.advance(2000)
  expect((await awayRows($)).rows).toEqual([sid(3), sid(8)])
  // sessions that change state show again
  fs.put(sid(1), 'done', NOW + 1_000)
  fs.put(sid(3), 'done', NOW + 1_500, { bars: [{ ...workBar, state: 'done' }] })
  await clock.advance(2000)
  expect((await awayRows($)).rows).toEqual([sid(1), sid(3), sid(8)])
})

test('a bar that moves mid-turn reaches the shared file within a second', async ($, on) => {
  engine(on, { clock: false })
  const clock = mock.clock(on, { now: NOW })
  turns(on)
  const fs = hostFs(on)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  expect(fs.mine().bars).toEqual([])
  await $.tool.call({ tool: TOOL, id: 'ship', title: '上線', stages: STAGES } as never)
  await clock.advance(1000)
  expect(fs.mine().bars.map((b: any) => b.title)).toEqual(['上線'])
  await $.tool.call({ tool: TOOL, id: 'ship', next: true } as never)
  await clock.advance(1000)
  expect(fs.mine().bars[0].stages[0].steps.map((st: any) => st.status)).toEqual(['done', 'active'])
})

test('the pane turns other sessions off and on, saved, on by default', async ($, on) => {
  const host = engine(on, { clock: false })
  const clock = mock.clock(on, { now: NOW })
  const fs = hostFs(on)
  fs.put(sid(1), 'done', NOW - 60_000)
  await start($)
  await clock.advance(2000)
  expect((await awayRows($)).rows).toEqual([sid(1)])
  const pane = await $.ui.mount({ plugin: 'plan-progress', surface: 'desktop', component: 'Pane', requestId: PANE, props: PANE_PROPS as never })
  expect((await pane.find({ key: 'cross-on' }))?.props.variant).toBe('primary')
  await pane.press({ key: 'cross-off' })
  expect(host.store.get('crossSessions')).toBe(false)
  expect((await awayRows($)).rows).toEqual([])
  await pane.press({ key: 'cross-on' })
  expect(host.store.get('crossSessions')).toBe(true)
  await clock.advance(2000)
  expect((await awayRows($)).rows).toEqual([sid(1)])
})

test('rows line up: titles are all plain buttons, the text right of the bars sits in one fixed-width column, titles get 40% of the row', async ($, on) => {
  engine(on, { clock: false })
  const clock = mock.clock(on, { now: NOW })
  const fs = hostFs(on)
  const doneBar = { id: 'b1', title: '回測', kind: 'plan', stages: [{ name: 'Run', steps: [{ title: 'a', status: 'done' }] }], state: 'done', note: null, startedAt: NOW - 200_000 }
  fs.put(sid(1), 'done', NOW - 60_000, { bars: [doneBar] })
  await start($)
  await $.command.run({ command: 'progress-style', args: 'beads' })
  // 28 wide characters fit in 40% of a 120-column row (about 384 px) but not in 30% (288 px); 40 do not fit at all
  const fits = '一二三四五六七八九十'.repeat(3).slice(0, 28)
  const tooLong = '一二三四五六七八九十'.repeat(4)
  await $.tool.call({ tool: TOOL, id: 'short', title: fits, stages: STAGES } as never)
  await $.tool.call({ tool: TOOL, id: 'long', title: tooLong, stages: STAGES } as never)
  await $.tool.call({ tool: TOOL, id: 'long', state: 'done' } as never)
  await clock.advance(2000)
  const above = await $.ui.mount({ plugin: 'plan-progress', surface: 'desktop', component: 'AbovePrompt', props: ABOVE as never })
  // every title, this session's and the other sessions', is the same kind of element, so they start at the same place
  const own = await above.find({ key: 'title-short' })
  expect(own?.type).toBe('Button')
  expect(own?.props.plain).toBe(true)
  expect((await above.find({ key: `switch-${sid(1)}` }))?.props.plain).toBe(true)
  expect(own?.text).toBe(fits)
  expect((await above.find({ key: 'title-long' }))?.text).toMatch(/…$/)
  // 0% beside 100%: the column is as wide as the widest text plus one cell, in every row
  const cols = (await above.findAll({ type: 'Box' })).filter((el: any) => el.props.justifyContent === 'flex-end' && el.props.key !== 'band-gear' && el.props.key !== 'band-fold')
  expect(cols.length).toBe(3)
  expect(new Set(cols.map((el: any) => el.props.width))).toEqual(new Set([5]))
  await above.unmount()
})

// the desktop attaches to a session while it shows it, and detaches when the person leaves it
function viewing(on: any) {
  on('session.attach', (_$: unknown, e: { clientId: string }) => ({ clientId: e.clientId }))
  on('session.detach', (_$: unknown, e: { clientId: string }) => ({ clientId: e.clientId }))
}
const DESK = { surface: 'desktop', clientId: 'desktop-2' }
const seenOf = (fs: ReturnType<typeof hostFs>) => JSON.parse(fs.files.get(`${DIR}/seen.json`)?.text ?? '{}')

test('opening a finished session from anywhere marks it seen for every session; opening a running one marks nothing', async ($, on) => {
  engine(on)
  turns(on)
  viewing(on)
  const fs = hostFs(on)
  await start($)
  // it runs while the person is elsewhere
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.session.attach(DESK as never)
  expect(seenOf(fs)[ME]).toBeUndefined()
  await $.session.detach({ ...DESK, reason: 'detach' } as never)
  // it finishes unwatched: the others show it
  await $.turn.complete(END as never)
  expect(fs.mine().state).toBe('done')
  expect(seenOf(fs)[ME]).toBeUndefined()
  // the person opens it, from the list, a notification or a bar's title alike
  await $.session.attach(DESK as never)
  expect(seenOf(fs)[ME]).toBe(fs.mine().since)
})

test('a session watched as it finishes is seen at once; one left before it finishes is not', async ($, on) => {
  engine(on, { clock: false })
  const clock = mock.clock(on, { now: NOW })
  turns(on)
  viewing(on)
  const fs = hostFs(on)
  await start($)
  await $.session.attach(DESK as never)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ ...END, answer: '要部署嗎？' } as never)
  expect(fs.mine().state).toBe('needs_input')
  expect(seenOf(fs)[ME]).toBe(fs.mine().since)
  // the person leaves; the next finish waits for them
  await $.session.detach({ ...DESK, reason: 'detach' } as never)
  await clock.advance(1000)
  await $.turn.start({ text: 'next', turnId: 't2' })
  await $.turn.complete({ ...END, turnId: 't2' } as never)
  expect(seenOf(fs)[ME]).toBeLessThan(fs.mine().since)
})

test('every row keeps its ✕ cell, so a running row without a ✕ keeps its bar in line', async ($, on) => {
  engine(on, { clock: false })
  const clock = mock.clock(on, { now: NOW })
  const fs = hostFs(on)
  fs.put(sid(1), 'done', NOW - 60_000)
  fs.put(sid(2), 'working', NOW - 10_000)
  await start($)
  await $.tool.call({ tool: TOOL, id: 'mine', title: 'mine', stages: STAGES } as never)
  await clock.advance(2000)
  const above = await $.ui.mount({ plugin: 'plan-progress', surface: 'desktop', component: 'AbovePrompt', props: ABOVE as never })
  expect(await above.find({ key: `seen-${sid(1)}` })).toBeDefined()
  expect(await above.find({ key: `seen-${sid(2)}` })).toBeUndefined()
  const cells = (await above.findAll({ type: 'Box' })).filter((el: any) => el.props.width === 3 && el.props.justifyContent === 'center' && el.props.key !== 'band-fold' && el.props.key !== 'band-fold-front')
  expect(cells.length).toBe(3)
  await above.unmount()
})

test('a session without a bar is named by the last message the person sent, never by a turn the system opened', async ($, on) => {
  engine(on)
  turns(on)
  const fs = hostFs(on)
  await start($)
  await $.prompt.submit({ text: '用 sleep 20 等 20 秒', asUser: true })
  await $.turn.start({ text: '用 sleep 20 等 20 秒', turnId: 't1' })
  await $.turn.complete(END as never)
  // a background task finishing opens a turn of its own, with no prompt from the person
  await $.turn.start({ text: '<task-notification> <task-id>b1</task-id>', turnId: 't2' })
  await $.turn.complete({ ...END, turnId: 't2' } as never)
  expect(fs.mine().label).toBe('用 sleep 20 等 20 秒')
})

test('opening a session fades its finished bars out; running bars stay', async ($, on) => {
  engine(on, { clock: false })
  const clock = mock.clock(on, { now: NOW })
  viewing(on)
  await $.tool.call({ tool: TOOL, id: 'finished', title: 'finished', stages: STAGES } as never)
  await $.tool.call({ tool: TOOL, id: 'finished', state: 'done' } as never)
  await $.tool.call({ tool: TOOL, id: 'working', title: 'working', stages: STAGES } as never)
  const look = async () => {
    const above = await $.ui.mount({ plugin: 'plan-progress', surface: 'desktop', component: 'AbovePrompt', props: ABOVE as never })
    const tree = JSON.stringify(await above.drawn())
    const rows = (await above.findAll({ type: 'Svg' })).filter((el: any) => isBarAlt(el.props.alt)).map((el: any) => String(el.props.source).includes('pp-leave'))
    await above.unmount()
    return { tree, rows }
  }
  expect((await look()).rows).toEqual([false, false])
  // the person opens this session from the list, a notification or a bar's title
  await $.session.attach(DESK as never)
  expect((await look()).rows).toEqual([true, false])
  await clock.advance(450)
  const after = await look()
  expect(after.rows).toEqual([false])
  expect(after.tree).toContain('working')
  expect(after.tree).not.toContain('"finished"')
})

test('a bar that finishes while the person watches stays until they leave and come back', async ($, on) => {
  engine(on, { clock: false })
  const clock = mock.clock(on, { now: NOW })
  viewing(on)
  await $.session.attach(DESK as never)
  await $.tool.call({ tool: TOOL, id: 'job', title: 'job', stages: STAGES } as never)
  await $.tool.call({ tool: TOOL, id: 'job', state: 'done' } as never)
  await clock.advance(450)
  expect(await barCount($)).toBe(1)
  await $.session.detach({ ...DESK, reason: 'detach' } as never)
  await $.session.attach(DESK as never)
  await clock.advance(450)
  expect(await barCount($)).toBe(0)
})

const APP_DIR = '/home/me/Library/Application Support/Claude/claude-code-sessions'
const appRecord = (fs: ReturnType<typeof hostFs>, hostId: string, title: string) =>
  fs.files.set(`${APP_DIR}/acct-1/org-1/${hostId}.json`, { text: JSON.stringify({ sessionId: hostId, title, enabledMcpTools: {} }), mtimeMs: NOW })

test('a session publishes the title the app lists it under, and picks up a title the app sets later', async ($, on) => {
  engine(on, { clock: false })
  const clock = mock.clock(on, { now: NOW })
  turns(on)
  const fs = hostFs(on)
  appRecord(fs, sid(9), 'not this one')
  appRecord(fs, ME, '')
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  expect(fs.mine().title).toBe('')
  // the app titles the session after its first turn
  appRecord(fs, ME, 'AGENTS.md 規則：優先列出需求')
  await clock.advance(60_000)
  expect(fs.mine().title).toBe('AGENTS.md 規則：優先列出需求')
  // and a turn's end reads it too
  appRecord(fs, ME, '改過的標題')
  await $.turn.complete(END as never)
  expect(fs.mine().title).toBe('改過的標題')
})

test('another session is named by its app title; without one, by its project (not a worktree folder) and its bar or message', async ($, on) => {
  engine(on, { clock: false })
  const clock = mock.clock(on, { now: NOW })
  const fs = hostFs(on)
  const wt = '/work/apm-monitor/.claude/worktrees/intelligent-sanderson-d2ebc9'
  fs.put(sid(1), 'working', NOW - 10_000, { title: 'ctv 回撤未停查因', cwd: wt })
  fs.put(sid(2), 'working', NOW - 10_000, { cwd: wt, label: '查跟賣' })
  fs.put(sid(3), 'working', NOW - 10_000, { cwd: wt, label: '' })
  await start($)
  await clock.advance(2000)
  const above = await $.ui.mount({ plugin: 'plan-progress', surface: 'desktop', component: 'AbovePrompt', props: ABOVE as never })
  expect((await above.find({ key: `switch-${sid(1)}` }))?.text).toBe('ctv 回撤未停查因')
  expect((await above.find({ key: `switch-${sid(2)}` }))?.text).toBe('apm-monitor · 查跟賣')
  expect((await above.find({ key: `switch-${sid(3)}` }))?.text).toBe('apm-monitor')
  expect(JSON.stringify(await above.drawn())).not.toContain('intelligent-sanderson')
  await above.unmount()
})

test('a row with no bar shows its state where the bars start, as wide as a bar', async ($, on) => {
  engine(on, { clock: false })
  const clock = mock.clock(on, { now: NOW })
  const fs = hostFs(on)
  const workBar = { id: 'b', title: '跑參數矩陣', kind: 'plan', stages: [{ name: 'Run', steps: [{ title: 'a', status: 'active' }] }], state: 'running', note: null, startedAt: NOW - 5_000 }
  fs.put(sid(1), 'done', NOW - 60_000, { title: '績效統計支援ETH、BASE鏈' })
  fs.put(sid(2), 'working', NOW - 10_000, { title: '任務停止監控優化', bars: [workBar] })
  await start($)
  await clock.advance(2000)
  const above = await $.ui.mount({ plugin: 'plan-progress', surface: 'desktop', component: 'AbovePrompt', props: ABOVE as never })
  const svgs = (await above.findAll({ type: 'Svg' })).filter((el: any) => isBarAlt(el.props.alt))
  const word = svgs.find((el: any) => String(el.props.alt).includes('績效統計'))
  const bar = svgs.find((el: any) => String(el.props.alt).includes('任務停止'))
  expect(String(word?.props.source)).toContain('>跑完了</text>')
  expect(String(word?.props.source)).toContain('<text x="0"')
  expect(word?.props.width).toBe(bar?.props.width)
  // not a loose word pushed to the right edge
  expect(await above.find({ type: 'Text', text: '跑完了' })).toBeUndefined()
  await above.unmount()
})

for (const surface of ['desktop', 'terminal'] as const) {
  test(`${surface}: with other sessions under them, this session's bars sit in a rounded frame; alone, no frame`, async ($, on) => {
    engine(on, { clock: false })
    const clock = mock.clock(on, { now: NOW })
    const fs = hostFs(on)
    appRecord(fs, ME, '日曆實測＋行李公斤')
    await start($)
    await $.tool.call({ tool: TOOL, id: 'mine', title: 'mine', stages: STAGES } as never)
    const mount = () => $.ui.mount({ plugin: 'plan-progress', surface, component: 'AbovePrompt', props: ABOVE as never })
    // alone: no frame
    const alone = await mount()
    expect(await alone.find({ key: 'own-frame' })).toBeUndefined()
    await alone.unmount()
    fs.put(sid(1), 'working', NOW - 10_000, { title: '機票天眼專案討論' })
    await clock.advance(2000)
    const both = await mount()
    const frame = await both.find({ key: 'own-frame' })
    expect(frame?.props.borderStyle).toBe('round')
    // the frame holds this session's bar and not the other session's row
    expect(JSON.stringify(frame)).toContain('title-mine')
    expect(JSON.stringify(frame)).not.toContain(`switch-${sid(1)}`)
    const list = await both.find({ key: 'away-list' })
    expect(JSON.stringify(list)).toContain(`switch-${sid(1)}`)
    expect(list?.props.paddingX).toBe(surface === 'terminal' ? 2 : 1)
    // the other sessions have no frame line around them (a "transparent" one shows black on the desktop)
    expect(list?.props.borderStyle).toBeUndefined()
    // on the desktop a few px under the frame, not a whole row, so the first other session sits as close as the rows below
    const gap = (await both.findAll({ type: 'Svg' })).find((el: any) => el.props.alt === '間距：外框')
    if (surface === 'desktop') expect(gap?.props.height).toBe(2)
    else expect(gap).toBeUndefined()
    // this session's name, as the other sessions show it, sits on the frame's top line and takes no row of its own
    const name = await both.find({ key: 'frame-name' })
    expect(name?.props).toMatchObject({ position: 'absolute', top: -1 })
    expect(JSON.stringify(name)).toContain('日曆實測＋行李公斤')
    if (surface === 'desktop') {
      // the desktop puts a Box one row up about 20 px above the line: the drawing is two rows tall, the name at its middle
      const svg = await both.find({ type: 'Svg', alt: '日曆實測＋行李公斤' })
      expect(svg?.props.height).toBe(40)
      // the name starts where the titles start, past the glyph's column; a halo of the band's grey round the letters
      // hides the line, so the gap is as wide on the right as on the left, and the line shows up to the name
      expect(String(svg?.props.source)).toContain('<text x="27" y="23.5"')
      expect(String(svg?.props.source)).toContain('stroke:#F0F0F0;stroke-width:12px')
      expect(String(svg?.props.source)).toContain('paint-order:stroke')
      expect(String(svg?.props.source)).not.toContain('<rect')
    }
    await both.unmount()
  })
}

test('the fold button folds the band to a lone button that opens it, and the choice is saved', async ($, on) => {
  const host = engine(on, { clock: false })
  const clock = mock.clock(on, { now: NOW })
  const fs = hostFs(on)
  await start($)
  await $.tool.call({ tool: TOOL, id: 'mine', title: 'mine', stages: STAGES } as never)
  const mount = () => $.ui.mount({ plugin: 'plan-progress', surface: 'desktop', component: 'AbovePrompt', props: ABOVE as never })
  const has = async (ui: any, key: string) => (await ui.find({ key })) !== undefined
  // one row: nothing to fold, no button
  const alone = await mount()
  expect(await has(alone, 'band-fold-button')).toBe(false)
  await alone.unmount()
  fs.put(sid(1), 'working', NOW - 10_000, { title: '其他一' })
  fs.put(sid(2), 'needs_input', NOW - 20_000, { title: '其他二' })
  await clock.advance(2000)
  const open = await mount()
  expect((await open.find({ key: 'band-fold-button' }))?.props.label).toBe('⌃')
  // on the desktop it sits on the band's top edge, at its middle, and takes no row or column
  expect((await open.find({ key: 'band-fold' }))?.props).toMatchObject({ position: 'absolute', top: -1, height: 2, justifyContent: 'center', width: 3, left: Math.floor(ABOVE.bodyColumns / 2) - 1 })
  // the band's grey is the button's own background, so the frame's line has a gap there and the button is drawn over it
  expect((await open.find({ key: 'band-fold-front' }))?.props).toMatchObject({ backgroundColor: '#F0F0F0', width: 3 })
  await open.press({ key: 'band-fold-button' })
  await open.unmount()
  expect(host.store.get('collapsed')).toBe(true)
  // folded: no rows at all, not even the one waiting on the person; one button, the rows it hides, in the band's middle
  const folded = await mount()
  for (const key of ['title-mine', `switch-${sid(1)}`, `switch-${sid(2)}`, 'own-frame', 'progress-style']) expect(await has(folded, key)).toBe(false)
  expect((await folded.find({ key: 'band-fold-button' }))?.props.label).toBe('⌄ 3')
  expect((await folded.find({ key: 'band-fold' }))?.props.justifyContent).toBe('center')
  await folded.press({ key: 'band-fold-button' })
  await folded.unmount()
  expect(host.store.get('collapsed')).toBe(false)
  // opened again, every row is back
  const all = await mount()
  for (const key of ['title-mine', `switch-${sid(1)}`, `switch-${sid(2)}`]) expect(await has(all, key)).toBe(true)
})

test('with no bar of this session own there is no frame, and no grey behind the fold button to cover the first row', async ($, on) => {
  engine(on, { clock: false })
  const clock = mock.clock(on, { now: NOW })
  const fs = hostFs(on)
  await start($)
  fs.put(sid(1), 'working', NOW - 10_000, { title: '其他一' })
  fs.put(sid(2), 'working', NOW - 10_000, { title: '其他二' })
  await clock.advance(2000)
  const above = await $.ui.mount({ plugin: 'plan-progress', surface: 'desktop', component: 'AbovePrompt', props: ABOVE as never })
  expect(await above.find({ key: 'own-frame' })).toBeUndefined()
  expect((await above.find({ key: 'band-fold-button' }))?.props.label).toBe('⌃')
  expect((await above.find({ key: 'band-fold-front' }))?.props.backgroundColor).toBeUndefined()
})

for (const surface of ['desktop', 'terminal'] as const) {
  test(`${surface}: rows sit a few px apart on the desktop, a whole row apart in a terminal`, async ($, on) => {
    engine(on, { clock: false })
    const clock = mock.clock(on, { now: NOW })
    const fs = hostFs(on)
    await start($)
    for (const n of [1, 2, 3]) fs.put(sid(n), 'working', NOW - n * 1000, { title: `其他${n}` })
    await clock.advance(2000)
    const above = await $.ui.mount({ plugin: 'plan-progress', surface, component: 'AbovePrompt', props: ABOVE as never })
    const spacers = (await above.findAll({ type: 'Svg' })).filter((el: any) => el.props.alt === '間距：列')
    if (surface === 'desktop') {
      // one spacer between each two of the three rows, 5 px tall, and no row gap besides
      expect(spacers.length).toBe(2)
      for (const sp of spacers) expect(sp.props.height).toBe(5)
    } else expect(spacers.length).toBe(0)
  })
}

test('desktop: two bars of this session sit one spacer apart, with no divider taking a second gap', async ($, on) => {
  engine(on, { clock: false })
  mock.clock(on, { now: NOW })
  hostFs(on)
  await start($)
  await $.tool.call({ tool: TOOL, id: 'a', title: 'a', stages: STAGES } as never)
  await $.tool.call({ tool: TOOL, id: 'b', title: 'b', stages: STAGES } as never)
  const above = await $.ui.mount({ plugin: 'plan-progress', surface: 'desktop', component: 'AbovePrompt', props: ABOVE as never })
  const svgs = await above.findAll({ type: 'Svg' })
  expect(svgs.filter((el: any) => el.props.alt === '間距：列').length).toBe(1)
  expect(svgs.filter((el: any) => el.props.alt === '').length).toBe(0)
})

test('the longest title shows whole, even when its estimated width is not a whole number', async ($, on) => {
  engine(on, { clock: false })
  const clock = mock.clock(on, { now: NOW })
  const fs = hostFs(on)
  await start($)
  // Latin letters make the estimate 91.2 px: rounded down to 91, the title column was cut one letter short (0.5.68)
  fs.put(sid(1), 'working', NOW - 10_000, { title: 'SOL跟單績效分析' })
  fs.put(sid(2), 'working', NOW - 10_000, { title: '行情天眼優化' })
  await clock.advance(2000)
  const above = await $.ui.mount({ plugin: 'plan-progress', surface: 'desktop', component: 'AbovePrompt', props: ABOVE as never })
  expect((await above.find({ key: `switch-${sid(1)}` }))?.props.label).toBe('SOL跟單績效分析')
})

test('a session started after the band was folded opens folded', async ($, on) => {
  engine(on, { clock: false, saved: { collapsed: true }, theme: 'dark-daltonized' })
  const clock = mock.clock(on, { now: NOW })
  const fs = hostFs(on)
  await start($)
  await $.tool.call({ tool: TOOL, id: 'mine', title: 'mine', stages: STAGES } as never)
  fs.put(sid(1), 'working', NOW - 10_000, { title: '其他一' })
  await clock.advance(2000)
  const above = await $.ui.mount({ plugin: 'plan-progress', surface: 'terminal', component: 'AbovePrompt', props: ABOVE as never })
  expect((await above.find({ key: 'band-fold-button' }))?.props.label).toBe('⌄ 2')
  expect(await above.find({ key: `switch-${sid(1)}` })).toBeUndefined()
  await above.press({ key: 'band-fold-button' })
  await above.unmount()
  // opened: a terminal has no room above the band, so ⌃ takes a column beside the gear there
  const opened = await $.ui.mount({ plugin: 'plan-progress', surface: 'terminal', component: 'AbovePrompt', props: ABOVE as never })
  expect((await opened.find({ key: 'band-fold' }))?.props.position).toBeUndefined()
  await opened.unmount()
  // a dark theme gives the desktop's ⌃ the dark grey
  const desk = await $.ui.mount({ plugin: 'plan-progress', surface: 'desktop', component: 'AbovePrompt', props: ABOVE as never })
  expect((await desk.find({ key: 'band-fold-front' }))?.props.backgroundColor).toBe('#2B2B29')
})

test('a session publishes the tool its main loop runs now, and clears it when the turn ends', async ($, on) => {
  engine(on, { clock: false })
  const clock = mock.clock(on, { now: NOW })
  turns(on)
  on('tool.call', () => ({ result: 'ok' }))
  const fs = hostFs(on)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  await clock.advance(1000)
  expect(fs.mine().tool).toBe('Bash')
  // the progress tool itself is not what the session does
  await $.tool.call({ tool: TOOL, id: 'x', title: 'x', stages: STAGES } as never)
  await clock.advance(1000)
  expect(fs.mine().tool).toBe('Bash')
  await $.turn.complete(END as never)
  expect(fs.mine().tool).toBe('')
})

test('a running session with no bar shows a sweeping track, what it does now and how long it has run', async ($, on) => {
  engine(on, { clock: false })
  const clock = mock.clock(on, { now: NOW })
  const fs = hostFs(on)
  fs.put(sid(1), 'working', NOW - 134_000, { tool: 'Bash', updatedAt: NOW - 1_000 })
  fs.put(sid(2), 'working', NOW - 5_000)
  fs.put(sid(3), 'working', NOW - 5_000, { tool: 'mcp__memelab__screen' })
  await start($)
  await clock.advance(2000)
  const above = await $.ui.mount({ plugin: 'plan-progress', surface: 'desktop', component: 'AbovePrompt', props: ABOVE as never })
  const svgs = await above.findAll({ type: 'Svg' })
  const svgOf = (n: number) => svgs.find((el: any) => String(el.props.alt).startsWith(`${n}-proj`))
  expect(String(svgOf(1)?.props.alt)).toBe('1-proj · task 1: 執行指令 · Bash')
  expect(String(svgOf(1)?.props.source)).toContain('class="sweep"')
  expect(String(svgOf(1)?.props.source)).toContain('執行指令 · Bash')
  // the words use the bars' note type, and the sweep and the dot take the style's running colour (segments: clay)
  expect(String(svgOf(1)?.props.source)).toContain('font:400 12px')
  expect(String(svgOf(1)?.props.source)).toContain('fill="#D97757"')
  expect((await above.findAll({ type: 'Svg' })).some((el: any) => String(el.props.alt).startsWith('狀態：') && String(el.props.source).includes('fill="#D97757"'))).toBe(true)
  expect(String(svgOf(2)?.props.alt)).toBe('2-proj · task 2: 處理中')
  expect(String(svgOf(3)?.props.alt)).toBe('3-proj · task 3: 外部工具 · memelab')
  const tree = JSON.stringify(await above.drawn())
  expect(tree).toContain('"2m 16s"')
  expect(tree).toContain('"7s"')
  // the elapsed time keeps counting on screen between polls
  await clock.advance(1000)
  expect(JSON.stringify(await above.drawn())).toContain('"2m 17s"')
  await above.unmount()
})

// ---------- the drawings themselves ----------
import { STYLES as LOOKS } from '../hooks/styles'
const st = (status: string) => ({ title: 's', status, substeps: [] })
const planOf = (state: string, stages: { name: string; steps: string[] }[]) =>
  ({ id: 'p', title: 'p', kind: 'plan', state, note: null, startedAt: NOW, stages: stages.map(s => ({ name: s.name, steps: s.steps.map(st) })) }) as never
const MID = [
  { name: 'Research', steps: ['done', 'done'] },
  { name: 'Build', steps: ['done', 'active', 'pending'] },
  { name: 'Verify', steps: ['pending', 'pending'] },
]

test('segments: the current stage is solid, finished ones a tint; no step ticks and no count inside the bar', () => {
  const svg = LOOKS.segments.draw(planOf('running', MID), 520, NOW, null).svg
  // Research is finished: a tint, not a solid cell
  expect(svg).toContain('fill:var(--clayS);fill-opacity:0.26')
  // Build is one fade with no hard edge: solid over its finished step, then through the active one to a tint,
  // its middle breathing on an eased curve; the name turns light over the solid part through the same fade
  expect(svg).toContain('<rect x="149.4" y="0" width="221.1" height="22" fill="url(#g1)"/>')
  expect(svg).toContain('style="stop-color:var(--clayS)" stop-opacity="1"')
  expect(svg).toMatch(/<animate attributeName="stop-opacity" values="0.7;0.35;0.7" keyTimes="0;.5;1" calcMode="spline"/)
  expect(svg).toContain('fill="url(#t1)"')
  expect(svg).not.toContain('url(#sweep)')
  expect(svg).not.toMatch(/height="8" style="fill:var\(--ink\)/)
  expect(svg).not.toContain('Build  2/3')
  // one rounded outline for the whole bar
  expect(svg).toContain('<g clip-path="url(#bar)">')
})

test('segments: waiting on the person, only the step at fault is amber and finished stages go grey', () => {
  const svg = LOOKS.segments.draw(planOf('needs_input', MID), 520, NOW, null).svg
  expect(svg).toContain('style="stop-color:var(--amber)" stop-opacity="0.6"')
  expect(svg).toContain('style="stop-color:var(--ink)" stop-opacity="0.22"')
  expect(svg).toContain('fill:var(--ink);fill-opacity:0.12')
  expect(svg).not.toContain('var(--clayS)')
})

test('segments: a stage too narrow for its name is a thin bar; the current one keeps its name', () => {
  const many = ['Research', 'Design', 'Build', 'Verify', 'Ship', 'Docs'].map((name, i) => ({ name, steps: i < 2 ? ['done'] : i === 2 ? ['active', 'pending', 'pending', 'pending'] : ['pending'] }))
  const svg = LOOKS.segments.draw(planOf('running', many), 300, NOW, null).svg
  expect(svg).toContain('height="6"')
  expect(svg).toContain('>Build</text>')
  expect(svg).not.toContain('>Ship</text>')
})

test('grid: one square per step, the active one blinks, a lone square sits at the middle', () => {
  const svg = LOOKS.grid.draw(planOf('running', MID), 520, NOW, null).svg
  expect((svg.match(/<rect /g) ?? []).length).toBe(7)
  expect(svg).toContain('attributeName="fill-opacity"')
  expect(svg).toContain('>Build</tspan>')
  expect(LOOKS.grid.right(planOf('running', MID), NOW)).toBe('3/7')
  // Build has three steps: its third sits alone in its column, at the middle (22 - 7) / 2
  expect(svg).toContain('y="8.0" width="6" height="6"')
})

test('segments: a stage on its first step has no solid head, so a dark name never sits on a dark fill', () => {
  const first = [{ name: 'Research', steps: ['done'] }, { name: 'Build', steps: ['active', 'pending'] }]
  const svg = LOOKS.segments.draw(planOf('running', first), 520, NOW, null).svg
  const fade = /<linearGradient id="g1".*?<\/linearGradient>/.exec(svg)?.[0] ?? ''
  expect(fade).not.toContain('stop-opacity="1"')
  expect(svg).not.toContain('fill="url(#t1)"')
})

import { setAccent } from '../hooks/styles'
const NARROW = ['Research', 'Design', 'Build', 'Verify', 'Ship', 'Docs'].map((name, i) => ({ name, steps: i < 2 ? ['done'] : i === 2 ? ['active', 'pending', 'pending', 'pending'] : ['pending'] }))

test('transit: the train is a ring, not three dots; names carry no count and are never cut', () => {
  const svg = LOOKS.transit.draw(planOf('running', MID), 520, NOW, null).svg
  expect(svg).not.toMatch(/r="1.2" style="fill:var\(--on\)/)
  expect(svg).toContain('>Build</text>')
  expect(svg).not.toContain('Build 2/3')
  const narrow = LOOKS.transit.draw(planOf('running', NARROW), 300, NOW, null).svg
  expect(narrow).toContain('>Build</text>')
  expect(narrow).not.toContain('…')
  // a name that does not fit its stretch is left out, not drawn over its neighbours
  expect(narrow).not.toContain('>Research</text>')
})

test('beads: on a narrow bar the stages stay at least 12 apart', () => {
  const svg = LOOKS.beads.draw(planOf('running', NARROW), 160, NOW, null).svg
  const xs = [...svg.matchAll(/<circle cx="([\d.]+)" cy="11"/g)].map(m => Number(m[1]))
  // Research and Design are one bead each: their centres sit a stage gap apart
  expect((xs[1] ?? 0) - (xs[0] ?? 0)).toBeGreaterThanOrEqual(18)
})

test('ledger: too narrow for every name, the current stage keeps its short one', () => {
  const svg = LOOKS.ledger.draw(planOf('running', NARROW), 300, NOW, null).svg
  expect(svg).toContain('>BUI</text>')
  expect(svg).not.toContain('>RES</text>')
})

test('hairline: the count lives only in the right column; done shows the count there', () => {
  const svg = LOOKS.hairline.draw(planOf('running', MID), 520, NOW, null).svg
  expect(svg).not.toContain('>3/7<')
  const done = planOf('done', MID.map(s => ({ ...s, steps: s.steps.map(() => 'done') })))
  expect(LOOKS.hairline.right(done, NOW)).toBe('7/7')
})

test('a picked colour recolours every style, its glyph and the black-and-white styles moving point', () => {
  setAccent('teal')
  try {
    expect(LOOKS.beads.draw(planOf('running', MID), 520, NOW, null).svg).toContain('--blue:#0E8A8F')
    expect(LOOKS.segments.draw(planOf('running', MID), 520, NOW, null).svg).toContain('--clayS:#0B7378')
    expect(LOOKS.beads.glyph(planOf('running', MID))?.color).toBe('#14A3A8')
    // waiting keeps its amber
    expect(LOOKS.beads.glyph(planOf('needs_input', MID))?.color).toBe('#E09A1E')
    expect(LOOKS.hairline.draw(planOf('running', MID), 520, NOW, null).svg).toContain('var(--acc, var(--ink))')
  } finally {
    setAccent(null)
  }
  expect(LOOKS.beads.draw(planOf('running', MID), 520, NOW, null).svg).not.toContain('--acc:')
})

test('the pane picks a colour, saved, and the bars redraw in it', async ($, on) => {
  const host = engine(on)
  await $.command.run({ command: 'progress-demo' })
  const props = { title: '進度條樣式', isFocused: true, bodyColumns: 50, placement: 'dock', scroll: SCROLL }
  const ui = await $.ui.mount({ plugin: 'plan-progress', surface: 'desktop', component: 'Pane', requestId: PANE, props: props as never })
  expect((await ui.find({ key: 'use-accent-own' }))?.props.variant).toBe('primary')
  // one named button per colour, and no colour dots beside them
  expect((await ui.find({ key: 'use-accent-teal' }))?.text).toBe('青')
  expect((await ui.findAll({ type: 'Svg' })).filter((el: any) => String(el.props.alt).startsWith('顏色：'))).toHaveLength(0)
  await ui.press({ key: 'use-accent-pink' })
  expect(host.store.get('accent')).toBe('pink')
  expect((await ui.find({ key: 'use-accent-pink' }))?.props.variant).toBe('primary')
  const above = await $.ui.mount({ plugin: 'plan-progress', surface: 'desktop', component: 'AbovePrompt', props: ABOVE as never })
  const bar = (await above.findAll({ type: 'Svg' })).find((el: any) => isBarAlt(el.props.alt))
  expect(String(bar?.props.source)).toContain('--clay:#B83A78')
  await above.unmount()
  await ui.press({ key: 'use-accent-own' })
  expect(host.store.get('accent')).toBe('')
  await ui.unmount()
})

test('desktop: every state glyph is drawn in one width, so the titles after them start at one place', async ($, on) => {
  engine(on, { clock: false })
  const clock = mock.clock(on, { now: NOW })
  const fs = hostFs(on)
  fs.put(sid(1), 'done', NOW - 60_000)
  fs.put(sid(2), 'needs_input', NOW - 30_000)
  fs.put(sid(3), 'working', NOW - 10_000)
  await start($)
  await $.tool.call({ tool: TOOL, id: 'mine', title: 'mine', stages: STAGES } as never)
  await clock.advance(2000)
  const above = await $.ui.mount({ plugin: 'plan-progress', surface: 'desktop', component: 'AbovePrompt', props: ABOVE as never })
  const glyphs = (await above.findAll({ type: 'Svg' })).filter((el: any) => String(el.props.alt).startsWith('狀態：') && String(el.props.source).includes('width="12"'))
  expect(glyphs.length).toBe(4)
  expect(new Set(glyphs.map((el: any) => `${el.props.width}x${el.props.height}`)).size).toBe(1)
  await above.unmount()
})

test('a session named by a message shows it as the person reads it, without the app tags around pasted text or commands', async ($, on) => {
  engine(on, { clock: false })
  const clock = mock.clock(on, { now: NOW })
  turns(on)
  const fs = hostFs(on)
  await start($)
  await $.prompt.submit({ text: '<pasted_content id="5589">\n0x2fab line one\nline two\n</pasted_content> 幫我查這個錢包', asUser: true })
  await $.turn.start({ text: 'x', turnId: 't1' })
  expect(fs.mine().label).toBe('（貼上的內容） 幫我查這個錢包')
  await $.turn.complete(END as never)
  // a raw label from a session on an older version is cleaned where it is read
  fs.put(sid(1), 'working', NOW - 5_000, { label: '<pasted_content id="77"> 0xabc' })
  fs.put(sid(2), 'working', NOW - 5_000, { label: '<command-message>handoff</command-message> <command-name>/handoff</command-name>' })
  await clock.advance(2000)
  const above = await $.ui.mount({ plugin: 'plan-progress', surface: 'desktop', component: 'AbovePrompt', props: ABOVE as never })
  // (the title column may cut it to fit; what matters is that no tag shows)
  const first = String((await above.find({ key: `switch-${sid(1)}` }))?.text)
  expect(first).toContain('1-proj · （貼上的內容')
  expect(first).not.toContain('<')
  expect((await above.find({ key: `switch-${sid(2)}` }))?.text).toBe('2-proj · /handoff')
  await above.unmount()
})

test('every style but hairline shows the step count right of the bar; hairline shows the time it has run', () => {
  for (const id of ['segments', 'beads', 'ledger', 'transit', 'grid'] as const) expect(LOOKS[id].right(planOf('running', MID), NOW)).toBe('3/7')
  expect(LOOKS.hairline.right({ ...(planOf('running', MID) as object), startedAt: NOW - 154_000 } as never, NOW)).toBe('2m 34s')
})

test('ledger: the current cell breathes on an eased curve instead of blinking on and off', () => {
  const svg = LOOKS.ledger.draw(planOf('running', MID), 520, NOW, null).svg
  expect(svg).toContain('values="1;.3;1" keyTimes="0;.5;1" calcMode="spline"')
  expect(svg).not.toContain('keyTimes="0;.5;.5;1"')
})

// worked out of order: two WinRate35 steps left for later, RBH done, SOL being worked on
const SKIPPED = [
  { name: 'WinRate35', steps: ['done', 'pending', 'pending'] },
  { name: 'RBH', steps: ['done'] },
  { name: 'SOL', steps: ['active'] },
  { name: 'Report', steps: ['pending'] },
]
const IN_ORDER = [
  { name: 'WinRate35', steps: ['done', 'done', 'active'] },
  { name: 'RBH', steps: ['pending'] },
  { name: 'SOL', steps: ['pending'] },
  { name: 'Report', steps: ['pending'] },
]

test('out of order: the text and count follow the active step, counting the finished ones', () => {
  const p = planOf('running', SKIPPED)
  for (const id of ['segments', 'beads', 'ledger', 'transit', 'grid'] as const) expect(LOOKS[id].right(p, NOW)).toBe('2/6')
  const beads = LOOKS.beads.draw(p, 520, NOW, null).svg
  expect(beads).toContain('>SOL</tspan>')
  expect(beads).not.toContain('>WinRate35</tspan>')
})

test('out of order: every style marks the steps left behind with a dashed outline, and only then', () => {
  for (const id of ['segments', 'hairline', 'beads', 'ledger', 'transit', 'grid'] as const) {
    expect(LOOKS[id].draw(planOf('running', SKIPPED), 520, NOW, null).svg).toContain('stroke-dasharray')
    expect(LOOKS[id].draw(planOf('running', IN_ORDER), 520, NOW, null).svg).not.toContain('stroke-dasharray')
  }
  // beads: exactly the two WinRate35 steps
  expect((LOOKS.beads.draw(planOf('running', SKIPPED), 520, NOW, null).svg.match(/stroke-dasharray/g) ?? []).length).toBe(2)
})

test('the bar row reads the active step, not the first open one', async ($, on) => {
  engine(on)
  const step = (title: string) => ({ title, status: 'pending' })
  await $.tool.call({ tool: TOOL, id: 'sol', title: 'SOL', stages: [
    { name: 'WinRate35', steps: [step('改門檻'), step('驗證與冷讀'), step('部署')] },
    { name: 'SOL', steps: [step('回撤拆解')] },
  ] } as never)
  await $.tool.call({ tool: TOOL, id: 'sol', done: ['改門檻'], active: '回撤拆解' } as never)
  const above = await $.ui.mount({ plugin: 'plan-progress', surface: 'desktop', component: 'AbovePrompt', props: ABOVE as never })
  const alt = String((await above.findAll({ type: 'Svg' })).find((el: any) => isBarAlt(el.props.alt))?.props.alt)
  expect(alt).toContain('SOL: SOL, step 1 of 1')
  await above.unmount()
})

test('segments: a step left behind inside the current stage is outlined, and the fade starts at the active step', () => {
  const svg = LOOKS.segments.draw(planOf('running', [{ name: 'Build', steps: ['done', 'pending', 'active'] }, { name: 'Verify', steps: ['pending'] }]), 520, NOW, null).svg
  expect((svg.match(/stroke-dasharray/g) ?? []).length).toBe(1)
  // the name is light over the finished first step
  expect(svg).toContain('fill="url(#t0)"')
})

test('desktop: every drawing a person should see carries a description, since a desktop draws no Svg whose alt is empty', async ($, on) => {
  engine(on, { clock: false })
  const clock = mock.clock(on, { now: NOW })
  const fs = hostFs(on)
  fs.put(sid(1), 'done', NOW - 60_000)
  fs.put(sid(2), 'working', NOW - 10_000)
  await start($)
  await $.tool.call({ tool: TOOL, id: 'mine', title: 'mine', stages: STAGES } as never)
  await $.tool.call({ tool: TOOL, id: 'two', title: 'two', stages: STAGES } as never)
  await clock.advance(2000)
  const above = await $.ui.mount({ plugin: 'plan-progress', surface: 'desktop', component: 'AbovePrompt', props: ABOVE as never })
  const pane = await $.ui.mount({ plugin: 'plan-progress', surface: 'desktop', component: 'Pane', requestId: PANE, props: PANE_PROPS as never })
  // the 1 px divider between bars is the one decoration
  const blank = [...(await above.findAll({ type: 'Svg' })), ...(await pane.findAll({ type: 'Svg' }))].filter((el: any) => el.props.alt === '' && el.props.height !== 1)
  expect(blank).toHaveLength(0)
  await above.unmount()
  await pane.unmount()
})
