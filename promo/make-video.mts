// Renders the vertical promo clip (1080x1920, 30 fps) frame by frame with the plugin's own drawing code,
// captures each frame in headless Chrome over the DevTools protocol, then joins them with ffmpeg.
// Run: node --experimental-strip-types promo/make-video.mts [outDir] [--stills=6.8,9.6,15.5]
// --stills writes only those moments as PNGs into outDir/stills, to check a layout without the full render.
// --audio-only writes just the soundtrack (outDir/soundtrack.wav), to listen to it without the full render.
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { STYLES } from '../plugins/plan-progress/hooks/styles.ts'

type StyleKey = keyof typeof STYLES
// the author's pixel bar (the 'original' style) is drawn inside the plugin's register.tsx, which only runs in Claude Code,
// so its drawing section and the few constants it reads are lifted from that file; a change there that breaks this throws here
function loadOriginal(): (p: unknown, W: number) => string {
  const src = readFileSync(new URL('../plugins/plan-progress/hooks/register.tsx', import.meta.url), 'utf8')
  const pick = (re: RegExp) => {
    const m = src.match(re)
    if (!m) throw new Error(`register.tsx no longer has ${re}`)
    return m[0]
  }
  const consts = [/^const AGENTS = .*$/m, /^const STATE_COLOR: .*$/m, /^const TRACK_H = .*$/m, /^const NARROW = .*$/m, /^const isFinished = .*$/m].map(pick)
  const start = src.indexOf('// ---------- drawing ----------')
  const end = src.indexOf('const AGENT_COLOR')
  if (start < 0 || end < start) throw new Error('register.tsx drawing section moved')
  return new Function(`${stripTypeScriptTypes([...consts, src.slice(start, end)].join('\n'))}\nreturn trackSvg`)()
}
const originalTrack = loadOriginal()
const ORIGINAL_H = 22
const args = process.argv.slice(2)
const stillsArg = args.find(a => a.startsWith('--stills='))
const STILLS = stillsArg ? stillsArg.slice('--stills='.length).split(',').map(Number) : null
const AUDIO_ONLY = args.includes('--audio-only')
const OUT_DIR = args.find(a => !a.startsWith('--')) ?? new URL('./out', import.meta.url).pathname
const FRAMES = STILLS ? `${OUT_DIR}/stills` : `${OUT_DIR}/frames`
const W = 1080
const H = 1920
const FPS = 60
const DURATION = 21.5
const S = 2 // UI drawn at 2x so it reads on a phone

// ---------- palette and type ----------
const BG = '#F5F3EE'
const CARD = '#FFFFFF'
const INK = '#1F1E1C'
const MUTED = '#86857F'
const LINE = '#E4E1D8'
const CLAY = '#C6613F'
const NATIVE = '#ECEAE4' // the desktop's grey native button
const FONT = "-apple-system,BlinkMacSystemFont,'PingFang TC','Helvetica Neue',sans-serif"

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v))
const easeOut = (x: number) => 1 - Math.pow(1 - clamp(x), 3)
const easeInOut = (x: number) => (clamp(x) < 0.5 ? 4 * clamp(x) ** 3 : 1 - Math.pow(-2 * clamp(x) + 2, 3) / 2)
const ramp = (t: number, a: number, b: number) => easeOut((t - a) / (b - a))
const fade = (t: number, inA: number, inB: number, outA = Infinity, outB = Infinity) => Math.min(ramp(t, inA, inB), 1 - ramp(t, outA, outB))
const text = (x: number, y: number, s: string, size: number, o: { fill?: string; weight?: number; anchor?: string; opacity?: number } = {}) =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${o.weight ?? 400}" fill="${o.fill ?? INK}" text-anchor="${o.anchor ?? 'start'}" opacity="${o.opacity ?? 1}">${esc(s)}</text>`
// rough text width in UI units at a given size: CJK takes a full em, Latin about 0.56 em
const textW = (s: string, size: number) => [...s].reduce((w, ch) => w + (/[　-鿿＀-￯]/.test(ch) ? size : size * 0.56), 0)
type Pt = { x: number; y: number }

// ---------- the demo plan ----------
const STAGES: [string, string[]][] = [
  ['Analysis', ['讀現有模組', '找相依關係', '列出改動']],
  ['Build', ['資料表結構', '寫遷移', '搬資料', '建索引']],
  ['Test', ['單元測試', '整合測試']],
  ['Ship', ['打包', '發佈']],
]
const TOTAL_STEPS = STAGES.reduce((n, [, s]) => n + s.length, 0)
function plan(k: number, now: number) {
  let i = 0
  return {
    id: 'promo',
    title: '重構訂單模組',
    kind: 'plan' as const,
    state: (k >= TOTAL_STEPS ? 'done' : 'running') as 'done' | 'running',
    note: null,
    startedAt: now - 192_000,
    stages: STAGES.map(([name, steps]) => ({
      name,
      steps: steps.map(title => {
        const idx = i++
        return { title, substeps: [], status: (idx < k ? 'done' : idx === k ? 'active' : 'pending') as 'done' | 'active' | 'pending' }
      }),
    })),
  }
}
// the pane's subagent preview, the same three sample runs the plugin shows
function sampleAgents(now: number) {
  return [
    { id: 'pa1', title: '讀取模組', state: 'running' as const, tool: 'Read', startedAt: now - 48_000, endedAt: null, depth: 0 },
    { id: 'pa2', title: '量 API 延遲', state: 'done' as const, tool: 'Done', startedAt: now - 72_000, endedAt: now - 6_000, depth: 0 },
    { id: 'pa3', title: '比對打包大小', state: 'waiting' as const, tool: 'Needs approval', startedAt: now - 9_000, endedAt: null, depth: 0 },
  ]
}
// a drawing placed centred in a fixed-height slot, as the pane does
const slot = (d: { svg: string; height: number }, w: number, h: number) =>
  `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" overflow="visible"><g transform="translate(0 ${(h - d.height) / 2})">${d.svg}</g></svg>`
// Claude Code swaps in a new picture whenever the plugin redraws, and the picture's animations (sweep, breathing,
// blink) start over from zero; data-start marks when a drawing was last redrawn, so capture() runs its clock from there
// Claude Code shows each drawing as its own picture, but here a whole frame is one page, so the fixed ids inside
// the drawings (segments' clip paths "s0", "f1", "sweep"…) would collide and one drawing would clip another;
// every drawing gets its own prefix
let drawingN = 0
const scopeIds = (svg: string) => {
  const k = `d${drawingN++}-`
  return svg.replace(/\bid="([^"]+)"/g, `id="${k}$1"`).replace(/url\(#([^)]+)\)/g, `url(#${k}$1)`).replace(/href="#([^"]+)"/g, `href="#${k}$1"`)
}
const drawnAt = (start: number, svg: string) => `<g data-start="${start}">${scopeIds(svg)}</g>`
const lastOf = (t: number, times: number[]) => Math.max(...times.filter(x => x <= t), 0)

// ---------- timeline ----------
const T = {
  titleOut: 1.5,
  uiIn: 1.7,
  agentsFold: 7.6, // the plugin folds finished strips after 5 s; shortened here
  gearMove: [8.0, 8.8],
  gearClick: 8.9,
  panelIn: 9.0,
  transitMove: [9.8, 10.6],
  transitClick: 10.7,
  closeMove: [11.5, 12.2],
  closeClick: 12.3,
  panelOut: 12.4,
  stepTen: 13.0,
  allDone: 13.6,
  inputMove: [14.1, 14.7],
  inputClick: 14.8,
  typeFrom: 14.9,
  sendMove: [16.1, 16.5],
  sendClick: 16.6,
  leave: 0.8, // the bar's fade, slower than the plugin's 0.4 s so it reads on video
  collapse: 0.3,
  cursorOut: [17.8, 18.1],
  uiOut: 18.6,
  endIn: 18.9,
}
// three subagents start under the bar, one stops for approval, all finish, then their strips fold away;
// each run lists [time, state, tool] changes from its start
type RunState = 'running' | 'waiting' | 'done'
const RUNS: { id: string; title: string; at: number; steps: [number, RunState, string][] }[] = [
  { id: 'a1', title: '讀取模組', at: 4.4, steps: [[4.4, 'running', 'Read'], [5.6, 'running', 'Grep'], [6.6, 'done', 'Done']] },
  { id: 'a2', title: '量 API 延遲', at: 4.7, steps: [[4.7, 'running', 'Bash'], [5.9, 'done', 'Done']] },
  { id: 'a3', title: '比對打包大小', at: 5.0, steps: [[5.0, 'running', 'Read'], [5.5, 'waiting', 'Needs approval'], [6.3, 'running', 'Bash'], [7.0, 'done', 'Done']] },
]
const AGENT_PACE = 14_000
const AGENT_EVENTS = RUNS.flatMap(r => r.steps.map(([at]) => at))
function agentsAt(t: number, now: number) {
  if (t >= T.agentsFold) return null
  const shown = RUNS.filter(r => t >= r.at).map(r => {
    const [, state, tool] = [...r.steps].reverse().find(([at]) => t >= at) ?? r.steps[0]
    const ended = state === 'done' ? r.steps[r.steps.length - 1][0] : null
    // the clip runs fast, so each video second counts as AGENT_PACE seconds on the strips' elapsed times
    return { id: r.id, title: r.title, state, tool, startedAt: now - (t - r.at) * AGENT_PACE, endedAt: ended === null ? null : now - (t - ended) * AGENT_PACE, depth: 0 }
  })
  return shown.length ? { shown, hidden: [] } : null
}
const MESSAGE = '接著幫我寫測試'
const CHAR_S = 0.14
const STEP_S = 1.1
const stepAt = (t: number) => (t >= T.allDone ? TOTAL_STEPS : t >= T.stepTen ? 9 : Math.min(8, 3 + Math.floor(Math.max(0, t - 2.2) / STEP_S)))
const styleAt = (t: number): StyleKey => (t < T.transitClick ? 'beads' : 'transit')
const typedAt = (t: number) => (t >= T.sendClick ? '' : MESSAGE.slice(0, clamp(Math.floor((t - T.typeFrom) / CHAR_S) + 1, 0, MESSAGE.length)))
const captionAt = (t: number): [string, number] => {
  if (t < 4.3) return ['Claude 做事時，進度一目了然', fade(t, 2.0, 2.4, 4.1, 4.3)]
  if (t < 7.8) return ['Subagent 跑到哪也看得到', fade(t, 4.3, 4.6, 7.6, 7.8)]
  if (t < 9.4) return ['點 ⚙ 打開設定面板', fade(t, 7.8, 8.1, 9.2, 9.4)]
  // the closing beat (the bar leaving after the next message) runs without a caption
  return ['六種風格，點一下就換', fade(t, 9.4, 9.7, 12.1, 12.4)]
}

// ---------- layout (px) ----------
const CARD_X = 60
const PAD = 16 * S
const IN_W = 448 // UI units
// the window card sits mid-screen, and slides up while the pane is open so both fit
const CARD_Y_REST = 700
const CARD_Y_UP = 250
const cardY = (t: number) => CARD_Y_REST + (CARD_Y_UP - CARD_Y_REST) * Math.min(easeInOut((t - T.gearClick) / 0.45), 1 - easeInOut((t - T.panelOut) / 0.45))
const PANEL_GAP = 36
// the pane is drawn a little smaller than the window card, so five of its six style tiles fit on screen
const SP = 1.6
const P_PAD = 16 * SP
const P_W = (W - 2 * CARD_X - 2 * P_PAD) / SP // UI units
const BAR_ROW = 48 // the bar's row, gone once the bar has left
const BAR_X = 96
// past 300 the strips under the bar also name each subagent's current tool
const BAR_W = 301
// UI units inside the window card, from its top-left inner corner
const INPUT = { y: 48, h: 44 }
const FOOT_Y = 117
const MODEL = 'Opus 5.5'
const EFFORT = 'Medium'
const SEND = { x: IN_W - 22, y: INPUT.y + 22 }
const EFFORT_END = IN_W
const MODEL_END = EFFORT_END - textW(EFFORT, 11.5) - 12
const GEAR_U = { x: MODEL_END - textW(MODEL, 11.5) - 12 - 10, y: FOOT_Y - 4 }

// how far the bar row has collapsed (0 = full, 1 = gone)
const collapsedAt = (t: number) => easeInOut((t - T.sendClick - T.leave) / T.collapse)
const leavingAt = (t: number) => clamp((t - T.sendClick) / T.leave)
// how much taller the bar's row is while subagent strips show under it
const growAt = (t: number) => {
  const now = 1_790_000_000_000 + t * 1000
  const v = agentsAt(t, now)
  if (!v) return 0
  const p = { ...plan(stepAt(t), now), agents: v.shown }
  const look = STYLES[styleAt(t)]
  return look.draw(p as never, BAR_W, now, v).height - look.draw(p as never, BAR_W, now, null).height
}
const inWindow = (t: number, u: Pt): Pt => ({ x: CARD_X + PAD + u.x * S, y: cardY(t) + PAD + (u.y + (u.y >= INPUT.y ? growAt(t) - collapsedAt(t) * BAR_ROW : 0)) * S })

// ---------- scene pieces ----------
function windowCard(t: number, style: StyleKey, gearHot: boolean): string {
  const now = 1_790_000_000_000 + t * 1000
  const v = agentsAt(t, now)
  const p = { ...plan(stepAt(t), now), ...(v ? { agents: v.shown } : {}) }
  const look = STYLES[style]
  const grow = growAt(t)
  const shift = collapsedAt(t) * BAR_ROW - grow
  const leave = leavingAt(t)
  const rowO = 1 - ramp(t, T.sendClick + T.leave - 0.1, T.sendClick + T.leave + 0.05)
  // the bar redraws when a step moves, when its style changes, on each subagent change,
  // and every second while subagents run (the plugin's clock ticks for their elapsed times)
  const stepMoves = [1, 2, 3, 4, 5].map(k => 2.2 + STEP_S * k)
  const agentTicks = Array.from({ length: Math.ceil(T.agentsFold - RUNS[0].at) }, (_, i) => RUNS[0].at + i + 1)
  const redraws = [T.uiIn, ...stepMoves, ...AGENT_EVENTS, ...agentTicks.filter(x => x < T.agentsFold), T.agentsFold, T.transitClick, T.stepTen, T.allDone]
  // with strips the drawing grows downward from where the plain bar sits
  const plainH = look.draw(p as never, BAR_W, now, null).height
  const drawn = look.draw(p as never, BAR_W, now, v)
  const bar = drawnAt(lastOf(t, redraws), `<svg width="${BAR_W}" height="${36 + grow}" overflow="visible"><g transform="translate(0 ${(36 - plainH) / 2})">${drawn.svg}</g></svg>`)
  const glyph = look.glyph(p as never)
  const typed = typedAt(t)
  const isTyping = t >= T.inputClick && t < T.sendClick
  const caretOn = isTyping && Math.floor((t - T.inputClick) / 0.5) % 2 === 0
  const caretX = 14 + textW(typed, 13) + 1
  // a leaving bar's drawing fades; its title, glyph and count dim, as the plugin does
  const dim = leave > 0
  const barRow =
    rowO > 0
      ? [
          `<g opacity="${rowO}">`,
          glyph ? text(0, 23, glyph.char, 12, { fill: dim ? MUTED : glyph.color }) : '',
          text(14, 23, p.title, 13, { weight: 500, fill: dim ? MUTED : INK }),
          `<g transform="translate(${BAR_X} 0)" opacity="${1 - leave}">${bar}</g>`,
          text(IN_W - 22, 23, look.right(p as never, now), 12, { fill: MUTED, anchor: 'end' }),
          text(IN_W - 6, 23, '✕', 11, { fill: MUTED, anchor: 'middle' }),
          `</g>`,
        ].join('')
      : ''
  const gear = `<rect x="${GEAR_U.x - 10}" y="${GEAR_U.y - 10}" width="20" height="20" rx="5" fill="${NATIVE}"/>` + text(GEAR_U.x, GEAR_U.y + 4.5, '⚙︎', 12.5, { fill: gearHot ? CLAY : MUTED, anchor: 'middle' })
  const ui = [
    barRow,
    `<g transform="translate(0 ${-shift})">`,
    `<rect x="0" y="${INPUT.y}" width="${IN_W}" height="${INPUT.h}" rx="12" fill="${CARD}" stroke="${isTyping ? MUTED : LINE}"/>`,
    typed ? text(14, 75, typed, 13) : text(14, 75, '請 Claude 幫你…', 13, { fill: MUTED }),
    caretOn ? `<rect x="${caretX}" y="62" width="1.4" height="17" fill="${INK}"/>` : '',
    `<circle cx="${SEND.x}" cy="${SEND.y}" r="12" fill="${typed ? INK : LINE}"/>`,
    `<path d="M${SEND.x} ${SEND.y + 5.5} V${SEND.y - 5} M${SEND.x - 4.5} ${SEND.y - 0.5} L${SEND.x} ${SEND.y - 5} L${SEND.x + 4.5} ${SEND.y - 0.5}" stroke="${CARD}" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
    gear,
    text(MODEL_END, FOOT_Y, MODEL, 11.5, { fill: MUTED, anchor: 'end' }),
    text(EFFORT_END, FOOT_Y, EFFORT, 11.5, { fill: MUTED, anchor: 'end' }),
    `</g>`,
  ].join('')
  const y = cardY(t)
  return `<rect x="${CARD_X}" y="${y}" width="${W - 2 * CARD_X}" height="${(150 - shift) * S}" rx="28" fill="${CARD}" stroke="${LINE}" stroke-width="2"/>
<g transform="translate(${CARD_X + PAD} ${y + PAD}) scale(${S})">${ui}</g>`
}

// a native-looking pane button, black and white as the desktop draws them; the current choice is filled black
const BTN_H = 22
const btnW = (label: string) => Math.max(36, textW(label, 11.5) + 22)
const button = (x: number, y: number, label: string, isOn: boolean) => {
  const w = btnW(label)
  return (
    (isOn ? `<rect x="${x}" y="${y}" width="${w}" height="${BTN_H}" rx="6" fill="${INK}"/>` : `<rect x="${x}" y="${y}" width="${w}" height="${BTN_H}" rx="6" fill="${CARD}" stroke="${LINE}"/>`) +
    text(x + w / 2, y + 15, label, 11.5, { fill: isOn ? '#FFFBF7' : INK, anchor: 'middle', weight: 500 })
  )
}
const buttonRow = (x: number, y: number, labels: string[], on: number) => {
  let cx = x
  return labels
    .map((l, i) => {
      const b = button(cx, y, l, i === on)
      cx += btnW(l) + 6
      return b
    })
    .join('')
}

// the pane as the plugin lays it out: the two on/off settings with save and close at the top right,
// the subagent view with its preview, then one bordered tile per style
const PANE_STYLES: [StyleKey | 'original', string][] = [
  ['segments', '分段'],
  ['hairline', '細線'],
  ['beads', '串珠'],
  ['ledger', '刻度字'],
  ['transit', '路線圖'],
  ['original', '原版'],
]
const TILE_W = P_W - 24
function paneLayout(style: StyleKey, now: number) {
  const agentsDrawn = STYLES[style].draw({ ...plan(5, now), id: 'preview-agents', agents: sampleAgents(now) } as never, P_W, now, { shown: sampleAgents(now), hidden: [] })
  const previews = PANE_STYLES.filter((e): e is [StyleKey, string] => e[0] !== 'original').map(([id]) => STYLES[id].draw({ ...plan(5, now), id: `preview-${id}` } as never, TILE_W, now, null))
  const slotH = Math.max(...previews.map(d => d.height))
  const agentsY = 104
  const listY = agentsY + agentsDrawn.height + 22
  const tileH = 10 + BTN_H + 8 + slotH + 10
  const tileY = (i: number) => listY + 12 + i * (tileH + 8)
  const useBtn = (i: number, isCurrent: boolean) => ({ x: P_W - 10 - btnW(isCurrent ? '✓ 使用中' : '使用'), y: tileY(i) + 10 })
  return { agentsDrawn, slotH, agentsY, listY, tileH, tileY, useBtn }
}

function panelCard(t: number, style: StyleKey): string {
  const now = 1_790_000_000_000 + t * 1000
  const L = paneLayout(style, now)
  const closeX = P_W - btnW('儲存並關閉')
  // the pane redraws when it opens and on every press in it
  const paneDrawn = lastOf(t, [T.panelIn, T.transitClick])
  const tiles = PANE_STYLES.map(([id, name], i) => {
    const ty = L.tileY(i)
    const isCurrent = id === style
    const b = L.useBtn(i, isCurrent)
    const drawn = id === 'original' ? { svg: originalTrack({ ...plan(5, now), id: 'preview-original' }, TILE_W), height: ORIGINAL_H } : STYLES[id].draw({ ...plan(5, now), id: `preview-${id}` } as never, TILE_W, now, null)
    const preview = `<g transform="translate(12 ${ty + 10 + BTN_H + 8})">${drawnAt(paneDrawn, slot(drawn, TILE_W, L.slotH))}</g>`
    return [
      `<rect x="0" y="${ty}" width="${P_W}" height="${L.tileH}" rx="10" fill="${CARD}" stroke="${isCurrent ? INK : LINE}" stroke-width="${isCurrent ? 1.5 : 1}"/>`,
      text(12, ty + 26, name, 13, { weight: 600, fill: INK }),
      text(12 + textW(name, 13) + 8, ty + 26, id, 11, { fill: MUTED }),
      button(b.x, b.y, isCurrent ? '✓ 使用中' : '使用', isCurrent),
      preview,
    ].join('')
  })
  const ui = [
    text(0, 13, '進度條', 13, { weight: 600 }),
    buttonRow(0, 22, ['顯示', '隱藏'], 0),
    text(130, 13, '提示音', 13, { weight: 600 }),
    buttonRow(130, 22, ['開', '關'], 0),
    button(closeX, 22, '儲存並關閉', true),
    text(0, 77, 'Subagent 顯示', 13, { weight: 600 }),
    buttonRow(0, 86 - 4, ['展開', '摘要', '隱藏'], 0),
    `<g transform="translate(0 ${L.agentsY + 8})">${drawnAt(paneDrawn, L.agentsDrawn.svg)}</g>`,
    text(0, L.listY + 4, '進度條樣式', 13, { weight: 600 }),
    ...tiles,
  ].join('')
  const y = cardY(t) + 150 * S + PANEL_GAP
  // the pane runs past the bottom of the frame, as a long pane scrolls
  return `<rect x="${CARD_X}" y="${y}" width="${W - 2 * CARD_X}" height="${H}" rx="28" fill="${CARD}" stroke="${LINE}" stroke-width="2"/>
<g transform="translate(${CARD_X + P_PAD} ${y + P_PAD}) scale(${SP})">${ui}</g>`
}
const inPanel = (t: number, u: Pt): Pt => ({ x: CARD_X + P_PAD + u.x * SP, y: cardY(t) + 150 * S + PANEL_GAP + P_PAD + u.y * SP })

function cursor(t: number): string {
  const now = 1_790_000_000_000 + t * 1000
  const home = { x: 940, y: 1560 }
  // where each press lands, read at the moment of the press so the cursor meets the button there
  const gear = inWindow(T.gearClick, GEAR_U)
  const tileAt = (i: number, style: StyleKey, at: number) => {
    const b = paneLayout(style, now).useBtn(i, false)
    return inPanel(at, { x: b.x + btnW('使用') - 4, y: b.y + 13 })
  }
  const transit = tileAt(4, 'beads', T.transitClick)
  const close = inPanel(T.closeClick, { x: P_W - 14, y: 22 + 12 })
  const input = inWindow(T.inputClick, { x: 150, y: INPUT.y + 26 })
  const send = inWindow(T.sendClick, { x: SEND.x + 2, y: SEND.y + 3 })
  const lerp = (a: Pt, b: Pt, e: number) => ({ x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e })
  const legs: [number[], Pt, Pt][] = [
    [T.gearMove, home, gear],
    [T.transitMove, gear, transit],
    [T.closeMove, transit, close],
    [T.inputMove, close, input],
    [T.sendMove, input, send],
  ]
  let at = home
  for (const [[a, b], from, to] of legs) if (t >= a) at = lerp(from, to, ramp(t, a, b))
  const opacity = fade(t, T.gearMove[0] - 0.2, T.gearMove[0], T.cursorOut[0], T.cursorOut[1])
  if (opacity <= 0) return ''
  const clicks = [T.gearClick, T.transitClick, T.closeClick, T.inputClick, T.sendClick]
  const ring = clicks
    .map(c => {
      const k = (t - c) / 0.4
      if (k < 0 || k > 1) return ''
      return `<circle cx="${at.x}" cy="${at.y}" r="${14 + 30 * easeOut(k)}" fill="none" stroke="${CLAY}" stroke-width="3" opacity="${(1 - k) * 0.7}"/>`
    })
    .join('')
  const press = clicks.some(c => t >= c && t < c + 0.12) ? 0.88 : 1
  return `<g opacity="${opacity}">${ring}<g transform="translate(${at.x} ${at.y}) scale(${1.7 * press})"><path d="M0 0 L0 21 L5.5 15.5 L9.5 24.5 L13 23 L9 14 L16.5 14 Z" fill="${INK}" stroke="#FFFFFF" stroke-width="1.6" stroke-linejoin="round"/></g></g>`
}

function frame(t: number): string {
  const style = styleAt(t)
  const titleO = 1 - ramp(t, T.titleOut, T.titleOut + 0.4)
  const uiO = fade(t, T.uiIn, T.uiIn + 0.4, T.uiOut, T.uiOut + 0.4)
  const panelO = fade(t, T.panelIn, T.panelIn + 0.35, T.panelOut, T.panelOut + 0.3)
  const panelDy = (1 - ramp(t, T.panelIn, T.panelIn + 0.35)) * 24 + ramp(t, T.panelOut, T.panelOut + 0.3) * 24
  const endO = ramp(t, T.endIn, T.endIn + 0.5)
  const [caption, capO] = captionAt(t)
  const gearHot = t > T.gearClick - 0.25 && t < T.gearClick + 0.4
  const parts = [`<rect width="${W}" height="${H}" fill="${BG}"/>`]
  if (titleO > 0)
    parts.push(
      `<g opacity="${titleO}">`,
      `<circle cx="${W / 2}" cy="760" r="14" fill="${CLAY}"/>`,
      text(W / 2, 900, 'plan-progress', 96, { weight: 700, anchor: 'middle' }),
      text(W / 2, 980, 'Claude Code 的即時進度條', 40, { fill: MUTED, anchor: 'middle' }),
      `</g>`,
    )
  if (uiO > 0) {
    parts.push(`<g opacity="${uiO}">`, text(W / 2, cardY(t) - 120, caption, 50, { weight: 700, anchor: 'middle', opacity: capO }), windowCard(t, style, gearHot), `</g>`)
    if (panelO > 0) parts.push(`<g opacity="${panelO * uiO}" transform="translate(0 ${panelDy})">`, panelCard(t, style), `</g>`)
  }
  parts.push(cursor(t))
  if (endO > 0)
    parts.push(
      `<g opacity="${endO}">`,
      `<circle cx="${W / 2}" cy="760" r="14" fill="${CLAY}"/>`,
      text(W / 2, 890, 'plan-progress', 88, { weight: 700, anchor: 'middle' }),
      text(W / 2, 1640, 'fork of zycck/claude-mods', 28, { fill: MUTED, anchor: 'middle' }),
      `</g>`,
    )
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`
}

// ---------- headless Chrome over the DevTools protocol ----------
async function capture(): Promise<void> {
  rmSync(FRAMES, { recursive: true, force: true })
  mkdirSync(FRAMES, { recursive: true })
  const profile = `${OUT_DIR}/chrome-profile`
  const port = 9333
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--hide-scrollbars', '--force-color-profile=srgb', 'about:blank',
  ], { stdio: 'ignore' })
  try {
    let targets: { type: string; webSocketDebuggerUrl: string }[] = []
    for (let i = 0; i < 50 && !targets.length; i++) {
      try { targets = ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as typeof targets).filter(x => x.type === 'page') } catch { await new Promise(r => setTimeout(r, 200)) }
    }
    if (!targets[0]) throw new Error('Chrome did not start')
    const ws = new WebSocket(targets[0].webSocketDebuggerUrl)
    await new Promise(r => ws.addEventListener('open', r, { once: true }))
    let id = 0
    const pending = new Map<number, (v: any) => void>()
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(String(ev.data))
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)!(msg.result ?? msg); pending.delete(msg.id) }
    })
    const send = (method: string, params: object = {}) => new Promise<any>(r => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })) })
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
    await send('Page.navigate', { url: 'data:text/html,<html><body style="margin:0;background:%23F5F3EE"></body></html>' })
    await new Promise(r => setTimeout(r, 500))
    const times = STILLS ?? Array.from({ length: DURATION * FPS }, (_, f) => f / FPS)
    for (const [f, t] of times.entries()) {
      const svg = frame(t)
      // SMIL animations (sweep, breathing head) are paused and set to this frame's time, so every frame is exact
      const ran = await send('Runtime.evaluate', {
        // every nested <svg> (each bar, each slot) keeps its own animation clock, so pause and seek all of them,
        // after the first draw: a fresh SVG ignores seeks until its timeline has started
        expression: `(() => { document.body.innerHTML = ${JSON.stringify(svg)}; const all = [...document.querySelectorAll('svg')]; const tick = () => new Promise(r => requestAnimationFrame(() => r())); return tick().then(tick).then(() => { for (const s of all) { const at = s.closest('[data-start]'); s.pauseAnimations(); s.setCurrentTime(Math.max(0, ${t} - (at ? Number(at.dataset.start) : 0))) } return tick().then(tick) }).then(() => all.length) })()`,
        awaitPromise: true,
        returnByValue: true,
      })
      if (ran.exceptionDetails) throw new Error(`frame ${f}: ${JSON.stringify(ran.exceptionDetails).slice(0, 400)}`)
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      const name = STILLS ? `t${t.toFixed(2)}` : `f${String(f).padStart(4, '0')}`
      writeFileSync(`${FRAMES}/${name}.png`, Buffer.from(shot.data, 'base64'))
      if (f % 60 === 0) console.log(`frame ${f}/${times.length}`)
    }
    ws.close()
  } finally {
    chrome.kill()
  }
}

// ---------- soundtrack: synthesized music under sound effects placed on the timeline ----------
// Everything is generated here (no downloaded music), except the plugin's own decision and done sounds,
// which play where the plugin would play them.
const SR = 44100
function soundtrack(): Float32Array[] {
  const n = Math.ceil(DURATION * SR)
  const L = new Float32Array(n)
  const Rt = new Float32Array(n)
  const add = (at: number, mono: Float32Array, gain: number, pan = 0) => {
    const o = Math.round(at * SR)
    const gl = gain * Math.min(1, 1 - pan)
    const gr = gain * Math.min(1, 1 + pan)
    for (let i = 0; i < mono.length && o + i < n; i++) {
      if (o + i < 0) continue
      L[o + i] += mono[i] * gl
      Rt[o + i] += mono[i] * gr
    }
  }
  const make = (sec: number, f: (t: number, i: number) => number) => Float32Array.from({ length: Math.round(sec * SR) }, (_, i) => f(i / SR, i))
  const env = (t: number, a: number, d: number) => (t < a ? t / a : Math.exp(-(t - a) / d))
  // white noise, repeatable
  let seed = 7
  const noise = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1
  const lowpass = (x: Float32Array, cutoff: number) => {
    const k = 1 - Math.exp((-2 * Math.PI * cutoff) / SR)
    let y = 0
    return x.map(v => (y += k * (v - y)))
  }
  const highpass = (x: Float32Array, cutoff: number) => {
    const lp = lowpass(x, cutoff)
    return x.map((v, i) => v - lp[i])
  }
  const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12)
  const readWav = (name: string) => {
    const buf = readFileSync(new URL(`../plugins/plan-progress/sounds/${name}.wav`, import.meta.url))
    const at = buf.indexOf('data') + 8 // 16-bit mono PCM, as the plugin ships them
    return Float32Array.from({ length: (buf.length - at) >> 1 }, (_, i) => buf.readInt16LE(at + i * 2) / 32768)
  }

  // music: 96 BPM, one chord a bar (Cmaj7, Am7, Fmaj7, G6), a soft pad, a bass note, a light kick and hat
  const BEAT = 60 / 96
  const BAR = BEAT * 4
  const CHORDS = [
    [48, [60, 64, 67, 71]],
    [45, [57, 60, 64, 67]],
    [41, [57, 60, 64, 65]],
    [43, [55, 59, 62, 64]],
  ] as const
  const musicIn = 0.3
  for (let b = 0; musicIn + b * BAR < DURATION; b++) {
    const [root, tones] = CHORDS[b % CHORDS.length]
    const at = musicIn + b * BAR
    const pad = make(BAR + 0.6, t => {
      const e = Math.min(1, t / 0.5) * Math.min(1, (BAR + 0.6 - t) / 0.6)
      return e * tones.reduce((sum, m, k) => sum + (Math.sin(2 * Math.PI * hz(m) * t + k) + 0.3 * Math.sin(2 * Math.PI * hz(m) * 1.004 * t)) / tones.length, 0)
    })
    add(at, lowpass(pad, 1800), 0.12, 0)
    const bass = make(BAR, t => Math.sin(2 * Math.PI * hz(root) * t) * env(t, 0.02, 0.9))
    add(at, bass, 0.13)
    // a plucked arpeggio on the eighths, once the interface is on screen
    if (at >= T.uiIn - BAR)
      for (let k = 0; k < 8; k++) {
        const m = tones[[0, 2, 1, 3, 2, 1, 3, 2][k]] + 12
        const pluck = make(0.5, t => (Math.sin(2 * Math.PI * hz(m) * t) + 0.25 * Math.sin(4 * Math.PI * hz(m) * t)) * env(t, 0.004, 0.16))
        add(at + (k * BEAT) / 2, pluck, 0.05, k % 2 ? 0.25 : -0.25)
      }
    for (let k = 0; k < 4; k++) {
      const t0 = at + k * BEAT
      if (t0 < T.uiIn) continue
      if (k % 2 === 0) add(t0, make(0.3, t => Math.sin(2 * Math.PI * (50 + 70 * Math.exp(-t * 30)) * t) * env(t, 0.002, 0.09)), 0.17)
      add(t0 + BEAT / 2, highpass(make(0.06, t => noise() * env(t, 0.001, 0.015)), 6000), 0.04, 0.3)
    }
  }
  // the music fades in under the title and out under the end card
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const g = Math.min(1, t / 1.2) * Math.min(1, (DURATION - t) / 1.6)
    L[i] *= g
    Rt[i] *= g
  }

  // effects
  const click = () => highpass(make(0.04, t => (noise() * 0.6 + Math.sin(2 * Math.PI * 2400 * t)) * env(t, 0.0005, 0.006)), 900)
  const key = () => highpass(make(0.035, t => noise() * env(t, 0.0005, 0.005)), 2500)
  const whoosh = (sec: number, up: boolean) => {
    const raw = make(sec, t => noise() * Math.sin((Math.PI * t) / sec) ** 2)
    return lowpass(raw, up ? 2600 : 1600)
  }
  const blip = (f: number) => make(0.18, t => Math.sin(2 * Math.PI * f * t) * env(t, 0.003, 0.05))
  const chime = (notes: number[]) => make(1.8, t => notes.reduce((sum, m, k) => sum + Math.sin(2 * Math.PI * hz(m) * t) * env(Math.max(0, t - k * 0.06), 0.005, 0.6) * (t >= k * 0.06 ? 1 : 0), 0) / notes.length)

  add(0.25, chime([72, 79]), 0.35) // the title
  for (const c of [T.gearClick, T.transitClick, T.closeClick, T.inputClick, T.sendClick]) add(c, click(), 0.9)
  add(T.panelIn, whoosh(0.35, true), 0.32)
  add(T.panelOut, whoosh(0.3, false), 0.25)
  for (const r of RUNS) add(r.at, blip(1320), 0.28, 0.2) // each subagent starting
  const waiting = RUNS.flatMap(r => r.steps.filter(([, st]) => st === 'waiting').map(([at]) => at))
  for (const at of waiting) add(at, readWav('decision'), 0.8)
  for (let i = 0; i < MESSAGE.length; i++) add(T.typeFrom + i * CHAR_S, key(), 0.6, (i % 3) * 0.1 - 0.1)
  add(T.allDone, readWav('done'), 0.8)
  add(T.sendClick + 0.05, whoosh(0.5, true), 0.3) // the message goes, the finished bar leaves
  add(T.endIn, chime([60, 67, 72, 76]), 0.35)

  // keep peaks under full scale
  const peak = [L, Rt].reduce((m, ch) => ch.reduce((mm, v) => Math.max(mm, Math.abs(v)), m), 0)
  if (peak > 0.89) for (let i = 0; i < n; i++) (L[i] *= 0.89 / peak), (Rt[i] *= 0.89 / peak)
  return [L, Rt]
}
function writeWav(path: string, [L, Rt]: Float32Array[]) {
  const n = L.length
  const buf = Buffer.alloc(44 + n * 4)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * 4, 4)
  buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(2, 22)
  buf.writeUInt32LE(SR, 24)
  buf.writeUInt32LE(SR * 4, 28)
  buf.writeUInt16LE(4, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(n * 4, 40)
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(clamp(L[i], -1, 1) * 32767), 44 + i * 4)
    buf.writeInt16LE(Math.round(clamp(Rt[i], -1, 1) * 32767), 46 + i * 4)
  }
  writeFileSync(path, buf)
}

mkdirSync(OUT_DIR, { recursive: true })
const AUDIO = `${OUT_DIR}/soundtrack.wav`
if (AUDIO_ONLY) {
  writeWav(AUDIO, soundtrack())
  console.log(`soundtrack: ${AUDIO}`)
} else {
  await capture()
  if (STILLS) {
    console.log(`stills: ${FRAMES}`)
  } else {
    writeWav(AUDIO, soundtrack())
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', `${FRAMES}/f%04d.png`, '-i', AUDIO, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', '-preset', 'slow', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '44100', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', `${OUT_DIR}/plan-progress-promo.mp4`], { stdio: 'inherit' })
    console.log(`done: ${OUT_DIR}/plan-progress-promo.mp4`)
  }
}
