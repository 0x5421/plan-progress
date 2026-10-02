import { expect, test } from 'claude-code/testing'

const SCROLL = { offset: 0, bodyRows: 40 }

// the engine's own answers beneath the plugin: a fixed clock, an in-memory store, an empty drawing
function engine(on: any) {
  const store = new Map<string, unknown>()
  // calls on $ answer { value }; events (ui.render, command.run) answer their result
  on('clock.now', () => ({ value: 1_790_000_000_000 }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.after', () => ({ value: undefined }))
  on('store.get', (_$: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', (_$: unknown, e: { key: string; value: unknown }) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.run', () => ({ text: '' }))
  on('audio.play', () => ({ value: undefined }))
}
const PANE = 'plan-progress-styles'
const STYLES = ['segments', 'hairline', 'beads', 'ledger', 'transit', 'original']

for (const surface of ['desktop', 'terminal'] as const) {
  test(`${surface}: the ▾ button sits beside Progress`, async ($, on) => {
    engine(on)
    const ui = await $.ui.mount({ plugin: 'plan-progress', surface, component: 'SessionMode', props: { modes: [] } as never })
    expect((await ui.find({ key: 'progress-style' }))?.text).toBe('▾')
    expect(await ui.find({ key: 'progress-toggle' })).toBeDefined()
  })

  test(`${surface}: the pane lists every style and a press switches it`, async ($, on) => {
    engine(on)
    const props = { title: '進度條樣式', isFocused: true, bodyColumns: 50, placement: 'dock', scroll: SCROLL }
    const ui = await $.ui.mount({ plugin: 'plan-progress', surface, component: 'Pane', requestId: PANE, props: props as never })
    for (const id of STYLES) expect(await ui.find({ key: `use-${id}` })).toBeDefined()
    expect((await ui.find({ key: 'use-segments' }))?.text).toBe('使用中')
    await ui.press({ key: 'use-beads' })
    expect((await ui.find({ key: 'use-beads' }))?.text).toBe('使用中')
    expect((await ui.find({ key: 'use-segments' }))?.text).toBe('使用')
  })
}

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
    // the ▾ on the bar row itself, beside ✕, opens the style pane
    expect((await ui.find({ key: 'style-demo' }))?.text).toBe('▾')
    expect(await ui.press({ key: 'style-demo' })).toBeDefined()
    await ui.unmount()
  }
})

test('/progress-style rejects an unknown name and cycles with next', async ($, on) => {
    engine(on)
  expect(JSON.stringify(await $.command.run({ command: 'progress-style', args: 'nope' }))).toContain('沒有')
  expect(JSON.stringify(await $.command.run({ command: 'progress-style', args: 'next' }))).toContain('已切換到 hairline')
})
