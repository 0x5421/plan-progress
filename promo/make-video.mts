// Renders the vertical promo clip (1080x1920, 30 fps) frame by frame with the plugin's own drawing code,
// captures each frame in headless Chrome over the DevTools protocol, then joins them with ffmpeg.
// Run: node --experimental-strip-types promo/make-video.mts [outDir] [--stills=6.8,9.6,15.5]
// --stills writes only those moments as PNGs into outDir/stills, to check a layout without the full render.
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
const OUT_DIR = args.find(a => !a.startsWith('--')) ?? new URL('./out', import.meta.url).pathname
const FRAMES = STILLS ? `${OUT_DIR}/stills` : `${OUT_DIR}/frames`
const W = 1080
const H = 1920
const FPS = 30
const DURATION = 20
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

// ---------- timeline ----------
const T = {
  titleOut: 1.5,
  uiIn: 1.7,
  gearMove: [5.6, 6.4],
  gearClick: 6.5,
  panelIn: 6.6,
  beadsMove: [7.2, 7.9],
  beadsClick: 8.0,
  transitMove: [8.7, 9.4],
  transitClick: 9.5,
  closeMove: [10.1, 10.8],
  closeClick: 10.9,
  panelOut: 11.0,
  stepTen: 11.6,
  allDone: 12.2,
  inputMove: [12.7, 13.3],
  inputClick: 13.4,
  typeFrom: 13.5,
  sendMove: [14.7, 15.1],
  sendClick: 15.2,
  leave: 0.8, // the bar's fade, slower than the plugin's 0.4 s so it reads on video
  collapse: 0.3,
  cursorOut: [16.4, 16.7],
  uiOut: 17.2,
  endIn: 17.5,
}
const MESSAGE = '接著幫我寫測試'
const CHAR_S = 0.14
const stepAt = (t: number) => (t >= T.allDone ? TOTAL_STEPS : t >= T.stepTen ? 9 : Math.min(8, 3 + Math.floor(Math.max(0, t - 2.2) / 0.85)))
const styleAt = (t: number): StyleKey => (t < T.beadsClick ? 'segments' : t < T.transitClick ? 'beads' : 'transit')
const typedAt = (t: number) => (t >= T.sendClick ? '' : MESSAGE.slice(0, clamp(Math.floor((t - T.typeFrom) / CHAR_S) + 1, 0, MESSAGE.length)))
const captionAt = (t: number): [string, number] => {
  if (t < 5.4) return ['Claude 做事時，進度一目了然', fade(t, 2.0, 2.4, 5.2, 5.4)]
  if (t < 7.0) return ['點 ⚙ 打開設定面板', fade(t, 5.4, 5.7, 6.8, 7.0)]
  // the closing beat (the bar leaving after the next message) runs without a caption
  return ['六種風格，點一下就換', fade(t, 7.0, 7.3, 10.7, 11.0)]
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
const BAR_X = 100
const BAR_W = 285
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
const inWindow = (t: number, u: Pt): Pt => ({ x: CARD_X + PAD + u.x * S, y: cardY(t) + PAD + (u.y - (u.y >= INPUT.y ? collapsedAt(t) * BAR_ROW : 0)) * S })

// ---------- scene pieces ----------
function windowCard(t: number, style: StyleKey, gearHot: boolean): string {
  const now = 1_790_000_000_000 + t * 1000
  const p = plan(stepAt(t), now)
  const look = STYLES[style]
  const shift = collapsedAt(t) * BAR_ROW
  const leave = leavingAt(t)
  const rowO = 1 - ramp(t, T.sendClick + T.leave - 0.1, T.sendClick + T.leave + 0.05)
  const bar = slot(look.draw(p as never, BAR_W, now, null), BAR_W, 36)
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

// a native-looking pane button; the current choice is filled
const BTN_H = 22
const btnW = (label: string) => Math.max(36, textW(label, 11.5) + 22)
const button = (x: number, y: number, label: string, isOn: boolean) => {
  const w = btnW(label)
  return (
    (isOn ? `<rect x="${x}" y="${y}" width="${w}" height="${BTN_H}" rx="6" fill="${CLAY}"/>` : `<rect x="${x}" y="${y}" width="${w}" height="${BTN_H}" rx="6" fill="${CARD}" stroke="${LINE}"/>`) +
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
  const tiles = PANE_STYLES.map(([id, name], i) => {
    const ty = L.tileY(i)
    const isCurrent = id === style
    const b = L.useBtn(i, isCurrent)
    const drawn = id === 'original' ? { svg: originalTrack({ ...plan(5, now), id: 'preview-original' }, TILE_W), height: ORIGINAL_H } : STYLES[id].draw({ ...plan(5, now), id: `preview-${id}` } as never, TILE_W, now, null)
    const preview = `<g transform="translate(12 ${ty + 10 + BTN_H + 8})">${slot(drawn, TILE_W, L.slotH)}</g>`
    return [
      `<rect x="0" y="${ty}" width="${P_W}" height="${L.tileH}" rx="10" fill="${CARD}" stroke="${isCurrent ? CLAY : LINE}" stroke-width="${isCurrent ? 1.5 : 1}"/>`,
      text(12, ty + 26, name, 13, { weight: 600, fill: isCurrent ? CLAY : INK }),
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
    `<g transform="translate(0 ${L.agentsY + 8})">${L.agentsDrawn.svg}</g>`,
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
  const beads = tileAt(2, 'segments', T.beadsClick)
  const transit = tileAt(4, 'beads', T.transitClick)
  const close = inPanel(T.closeClick, { x: P_W - 14, y: 22 + 12 })
  const input = inWindow(T.inputClick, { x: 150, y: INPUT.y + 26 })
  const send = inWindow(T.sendClick, { x: SEND.x + 2, y: SEND.y + 3 })
  const lerp = (a: Pt, b: Pt, e: number) => ({ x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e })
  const legs: [number[], Pt, Pt][] = [
    [T.gearMove, home, gear],
    [T.beadsMove, gear, beads],
    [T.transitMove, beads, transit],
    [T.closeMove, transit, close],
    [T.inputMove, close, input],
    [T.sendMove, input, send],
  ]
  let at = home
  for (const [[a, b], from, to] of legs) if (t >= a) at = lerp(from, to, ramp(t, a, b))
  const opacity = fade(t, 5.4, 5.6, T.cursorOut[0], T.cursorOut[1])
  if (opacity <= 0) return ''
  const clicks = [T.gearClick, T.beadsClick, T.transitClick, T.closeClick, T.inputClick, T.sendClick]
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
  const gearHot = t > 6.25 && t < 6.9
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
      text(W / 2, 970, '6 種進度條風格，點齒輪一鍵切換', 40, { fill: INK, anchor: 'middle' }),
      text(W / 2, 1640, 'fork of zycck/claude-mods · by @0x5421', 28, { fill: MUTED, anchor: 'middle' }),
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
        expression: `(() => { document.body.innerHTML = ${JSON.stringify(svg)}; const all = [...document.querySelectorAll('svg')]; const tick = () => new Promise(r => requestAnimationFrame(() => r())); return tick().then(tick).then(() => { for (const s of all) { s.pauseAnimations(); s.setCurrentTime(${t}) } return tick().then(tick) }).then(() => all.length) })()`,
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

await capture()
if (STILLS) {
  console.log(`stills: ${FRAMES}`)
} else {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', `${FRAMES}/f%04d.png`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', '-preset', 'slow', '-movflags', '+faststart', `${OUT_DIR}/plan-progress-promo.mp4`], { stdio: 'inherit' })
  console.log(`done: ${OUT_DIR}/plan-progress-promo.mp4`)
}
