import { expect, mock, test } from 'claude-code/testing'

const SCROLL = { offset: 0, bodyRows: 40 }

// the engine's own answers beneath the plugin: a fixed clock, an in-memory store, an empty drawing
function engine(on: any, opts: { clock?: boolean; saved?: Record<string, unknown> } = {}) {
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
const STYLES = ['segments', 'hairline', 'beads', 'ledger', 'transit', 'original']

for (const surface of ['desktop', 'terminal'] as const) {
  test(`${surface}: the footer draws one ⚙ button, which opens the style pane`, async ($, on) => {
    const host = engine(on)
    const ui = await $.ui.mount({ plugin: 'plan-progress', surface, component: 'SessionMode', props: { modes: [] } as never })
    // the desktop footer draws no Client region (0.5.7-0.5.9 showed nothing there), so it stays a Button;
    // one glyph keeps the desktop's grey box small
    expect(await ui.findAll({ type: 'Client' })).toHaveLength(0)
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(1)
    expect((await ui.find({ key: 'progress-style' }))?.text).toBe('\u2699\uFE0E')
    // no labels after the gear: no gap, so it sits as far from the model name as the footer's own items
    expect((await ui.drawn()).props.gap).toBe(0)
    const withModes = await $.ui.mount({ plugin: 'plan-progress', surface, component: 'SessionMode', props: { modes: ['focus'] } as never })
    expect((await withModes.drawn()).props.gap).toBe(1)
    await ui.press({ key: 'progress-style' })
    expect(host.opened).toEqual([PANE])
  })

  test(`${surface}: the pane shows and hides the bars`, async ($, on) => {
    engine(on)
    await $.command.run({ command: 'progress-demo' })
    const props = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: SCROLL }
    const bars = async () => {
      const above = await $.ui.mount({ plugin: 'plan-progress', surface: 'desktop', component: 'AbovePrompt', props: props as never })
      const n = (await above.findAll({ type: 'Svg' })).length
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
  const previews = (await svgSizes()).slice(1)
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
    const svg = await ui.findAll({ type: 'Svg' })
    expect(svg.length).toBe(1)
    // the ⚙ lives in the footer only, not on the bar row
    expect(await ui.find({ key: 'style-demo' })).toBeUndefined()
    // counts read like 5/16, never zero-padded
    expect(JSON.stringify(await ui.drawn())).not.toMatch(/"0\d\/\d+"/)
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
    const rows = (await above.findAll({ type: 'Svg' })).filter(el => el.props.alt !== '').map(el => String(el.props.source).includes('pp-leave'))
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
  const n = (await above.findAll({ type: 'Svg' })).filter((el: any) => el.props.alt !== '').length
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
  const alts = (await above.findAll({ type: 'Svg' })).filter((el: any) => el.props.alt !== '').map((el: any) => String(el.props.alt))
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
