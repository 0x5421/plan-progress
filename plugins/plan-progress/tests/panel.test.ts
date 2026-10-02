import { expect, mock, test } from 'claude-code/testing'

const SCROLL = { offset: 0, bodyRows: 40 }

// the engine's own answers beneath the plugin: a fixed clock, an in-memory store, an empty drawing
function engine(on: any, opts: { clock?: boolean } = {}) {
  const store = new Map<string, unknown>()
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
  on('audio.play', () => ({ value: undefined }))
  on('ui.message', () => ({}))
  on('prompt.submit', (_$: unknown, e: { text: string }) => ({ text: e.text }))
  return { store, closed, opened, toasts }
}
const PANE = 'plan-progress-styles'
const STYLES = ['segments', 'hairline', 'beads', 'ledger', 'transit', 'original']

for (const surface of ['desktop', 'terminal'] as const) {
  test(`${surface}: the footer draws "Progress ⚙" as plain text, no buttons`, async ($, on) => {
    engine(on)
    const ui = await $.ui.mount({ plugin: 'plan-progress', surface, component: 'SessionMode', props: { modes: [] } as never })
    // a Button gets the desktop's native grey box, which also clipped the "g"
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
    const footer = JSON.stringify(await ui.drawn({ in: 'progress-footer' }))
    expect(footer).toContain('Progress')
    expect(footer).toContain('⚙︎')
    expect(footer).not.toContain('Button')
    // the region names its size: left to measure itself it drew nothing in the desktop footer (0.5.8)
    const region = await ui.find({ key: 'progress-footer' })
    expect(region?.props.width).toBe(11)
    expect(region?.props.height).toBe(1)
  })

  test(`${surface}: a click on ⚙ opens the style pane, a click on Progress toggles the bars`, async ($, on) => {
    const host = engine(on)
    const ui = await $.ui.mount({ plugin: 'plan-progress', surface, component: 'SessionMode', props: { modes: [] } as never })
    // "Progress" takes columns 0-7, the space 8, the gear 9
    await ui.pointer({ type: 'up', x: 9, y: 0, button: 'left', in: 'progress-footer' } as never)
    expect(host.opened).toEqual([PANE])
    // no bar yet: the label says how the mod works instead of toggling nothing
    await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left', in: 'progress-footer' } as never)
    expect(host.toasts).toHaveLength(1)
    expect(host.opened).toEqual([PANE])
    // with a bar, the label hides it and shows it again
    await $.command.run({ command: 'progress-demo' })
    const props = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: SCROLL }
    const bars = async () => {
      const above = await $.ui.mount({ plugin: 'plan-progress', surface: 'desktop', component: 'AbovePrompt', props: props as never })
      const n = (await above.findAll({ type: 'Svg' })).length
      await above.unmount()
      return n
    }
    expect(await bars()).toBe(1)
    await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left', in: 'progress-footer' } as never)
    expect(await bars()).toBe(0)
    await ui.pointer({ type: 'up', x: 2, y: 0, button: 'left', in: 'progress-footer' } as never)
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
    // it sits on the same row as 展開／摘要／隱藏, last, after a spacer that pushes it to the right edge
    const row = (await ui.find({ key: 'agents-row' }))?.children as { key?: string; type?: string; props?: Record<string, unknown> }[]
    expect(row.map(c => (c.props?.key as string | undefined) ?? c.key ?? c.type)).toEqual(['agents-expanded', 'agents-summary', 'agents-hidden', 'Box', 'save-close'])
    expect(row[3]?.props?.flexGrow).toBe(1)
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
