// Renders the vertical promo clip (1080x1920, 30 fps) frame by frame with the plugin's own drawing code,
// captures each frame in headless Chrome over the DevTools protocol, then joins them with ffmpeg.
// Run: node --experimental-strip-types promo/make-video.mts [outDir] [--stills=6.8,9.6,15.5]
// --stills writes only those moments as PNGs into outDir/stills, to check a layout without the full render.
// --audio-only writes just the soundtrack (outDir/soundtrack.wav): the clicks and the plugin's done sound, no music.
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
const DURATION = 28
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

// ---------- the demo plans ----------
const STAGES: [string, string[]][] = [
  ['Analysis', ['讀現有模組', '找相依關係', '列出改動']],
  ['Build', ['資料表結構', '寫遷移', '搬資料', '建索引']],
  ['Test', ['單元測試', '整合測試']],
  ['Ship', ['打包', '發佈']],
]
const TOTAL_STEPS = STAGES.reduce((n, [, s]) => n + s.length, 0)
function stagesOf(stages: [string, string[]][], k: number) {
  let i = 0
  return stages.map(([name, steps]) => ({
    name,
    steps: steps.map(title => {
      const idx = i++
      return { title, substeps: [], status: (idx < k ? 'done' : idx === k ? 'active' : 'pending') as 'done' | 'active' | 'pending' }
    }),
  }))
}
// a bar whose steps are all ticked stays running until the turn ends: the plugin turns it done once the reply is written
function plan(k: number, now: number, isDone = k >= TOTAL_STEPS) {
  return { id: 'promo', title: '重構訂單模組', kind: 'plan' as const, state: (isDone ? 'done' : 'running') as 'done' | 'running', note: null, startedAt: now - 192_000, stages: stagesOf(STAGES, k) }
}
// two other sessions running beside this one
const API_STAGES: [string, string[]][] = [
  ['Build', ['打包', '推映像']],
  ['Deploy', ['換版', '健康檢查']],
  ['Watch', ['看日誌', '收尾']],
]
const BOT_STAGES: [string, string[]][] = [
  ['Data', ['抓資料', '清資料']],
  ['Run', ['跑回測', '算績效']],
  ['Report', ['寫報告']],
]
const other = (id: string, title: string, stages: [string, string[]][], k: number, isDone: boolean, now: number, ago: number) => ({
  id,
  title,
  kind: 'plan' as const,
  state: (isDone ? 'done' : 'running') as 'done' | 'running',
  note: null,
  startedAt: now - ago,
  stages: stagesOf(stages, k),
})
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
  stepLast: 13.5, // every step ticked: the bar holds at 100% while Claude writes its reply
  replyFrom: 13.7,
  replyTo: 15.0,
  allDone: 15.3, // the reply is written: the bar turns done and the done sound plays
  crossIn: 16.2, // the other sessions' bars show under this one
  botDone: 17.8, // another session finishes; this session plays nothing for it
  botMove: [19.2, 19.9],
  botClick: 20.0, // its title is pressed: the app switches to that session
  switchDur: 0.4,
  inputMove: [21.0, 21.6],
  inputClick: 21.7,
  typeFrom: 21.8,
  sendMove: [22.9, 23.3],
  sendClick: 23.4,
  leave: 0.8, // the bar's fade, slower than the plugin's 0.4 s so it reads on video
  collapse: 0.3,
  cursorOut: [24.6, 24.9],
  uiOut: 25.4,
  endIn: 25.7,
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
const MESSAGE = '接著跑第 6 批'
const CHAR_S = 0.14
const STEP_S = 1.1
const REPLY = '重構完成：四個階段都跑完，測試全數通過。'
const BOT_REPLY = '回測跑完了，報告放在 report.md。'
const stepAt = (t: number) => (t >= T.stepLast ? TOTAL_STEPS : t >= T.stepTen ? 9 : Math.min(8, 3 + Math.floor(Math.max(0, t - 2.2) / STEP_S)))
const styleAt = (t: number): StyleKey => (t < T.transitClick ? 'beads' : 'transit')
const typedAt = (t: number) => (t >= T.sendClick ? '' : MESSAGE.slice(0, clamp(Math.floor((t - T.typeFrom) / CHAR_S) + 1, 0, MESSAGE.length)))
const replyAt = (t: number) => REPLY.slice(0, Math.round(REPLY.length * clamp((t - T.replyFrom) / (T.replyTo - T.replyFrom))))
const apiStepAt = (t: number) => clamp(2 + Math.floor(Math.max(0, t - T.crossIn) / 2.6), 2, 5)
const captionAt = (t: number): [string, number] => {
  if (t < 4.3) return ['Claude 做事時，進度一目了然', fade(t, 2.0, 2.4, 4.1, 4.3)]
  if (t < 7.8) return ['Subagent 跑到哪也看得到', fade(t, 4.3, 4.6, 7.6, 7.8)]
  if (t < 9.4) return ['點 ⚙ 打開設定面板', fade(t, 7.8, 8.1, 9.2, 9.4)]
  if (t < 12.6) return ['六種風格，點一下就換', fade(t, 9.4, 9.7, 12.1, 12.4)]
  if (t < 16.0) return ['回覆寫完，才亮 Done、響完成音', fade(t, 12.8, 13.1, 15.8, 16.0)]
  if (t < 19.0) return ['其他 session 的進度也看得到', fade(t, 16.2, 16.5, 18.8, 19.0)]
  if (t < 21.5) return ['點標題，直接切過去', fade(t, 19.0, 19.3, 21.2, 21.5)]
  return ['送出下一則，完成的進度條自動收起', fade(t, 21.6, 21.9, 24.4, 24.7)]
}

// ---------- layout (px) ----------
const CARD_X = 60
const PAD = 16 * S
const IN_W = 448 // UI units
const HEAD = 24 // the session's name above its bars
// the window card sits mid-screen, and slides up while the pane is open so both fit
const CARD_Y_REST = 660
const CARD_Y_UP = 200
const cardY = (t: number) => CARD_Y_REST + (CARD_Y_UP - CARD_Y_REST) * Math.min(easeInOut((t - T.gearClick) / 0.45), 1 - easeInOut((t - T.panelOut) / 0.45))
const PANEL_GAP = 36
// the pane is drawn a little smaller than the window card, so its first style tiles fit on screen
const SP = 1.6
const P_PAD = 16 * SP
const P_W = (W - 2 * CARD_X - 2 * P_PAD) / SP // UI units
const BAR_ROW = 48 // the bar's row, gone once the bar has left
// UI units inside the window card, from the top of the bar area
const INPUT = { y: 48, h: 44 }
const FOOT_Y = 117
const MODEL = 'Opus 5.5'
const EFFORT = 'Medium'
const SEND = { x: IN_W - 22, y: INPUT.y + 22 }
const EFFORT_END = IN_W
const MODEL_END = EFFORT_END - textW(EFFORT, 11.5) - 12
const GEAR_U = { x: MODEL_END - textW(MODEL, 11.5) - 12 - 10, y: FOOT_Y - 4 }

// ---------- the two sessions on screen: shop (where the clip starts) and bot (where it switches to) ----------
type Which = 'shop' | 'bot'
type Row = { folder: string; p: ReturnType<typeof other> }
const titleOf = (r: Row) => `${r.folder} · ${r.p.title}`
const whichAt = (t: number): Which => (t < T.botClick ? 'shop' : 'bot')
function viewOf(which: Which, t: number, now: number) {
  const api: Row = { folder: 'api', p: other('api', '部署', API_STAGES, apiStepAt(t), false, now, 140_000) }
  const isBotDone = t >= T.botDone
  const bot = other('bot', '回測', BOT_STAGES, isBotDone ? 5 : 4, isBotDone, now, 410_000)
  if (which === 'shop') {
    const v = agentsAt(t, now)
    const own = { ...plan(stepAt(t), now, t >= T.allDone), ...(v ? { agents: v.shown } : {}) }
    // the plugin lists waiting sessions first, then finished, then running
    const away: Row[] = isBotDone ? [{ folder: 'bot', p: bot }, api] : [api, { folder: 'bot', p: bot }]
    return { name: 'shop', own, agents: v, away, appear: ramp(t, T.crossIn, T.crossIn + 0.4) }
  }
  const shop = { ...plan(TOTAL_STEPS, now, true), id: 'shop' }
  return { name: 'bot', own: bot, agents: null, away: [{ folder: 'shop', p: shop }, api] as Row[], appear: 1 }
}
// every bar starts where the longest title ends, as the plugin lines them up
const barXOf = (v: ReturnType<typeof viewOf>) => 14 + Math.max(textW(v.own.title, 13), ...v.away.map(r => textW(titleOf(r), 13))) + 4
const barWOf = (v: ReturnType<typeof viewOf>) => IN_W - barXOf(v) - 51

// how far the bar row has collapsed (0 = full, 1 = gone); only the bot session's bar leaves, after the message is sent
const collapsedAt = (t: number) => easeInOut((t - T.sendClick - T.leave) / T.collapse)
const leavingAt = (t: number) => clamp((t - T.sendClick) / T.leave)
// how much taller the bar's row is while subagent strips show under it
const growAt = (t: number) => {
  const now = 1_790_000_000_000 + t * 1000
  const v = agentsAt(t, now)
  if (!v) return 0
  const p = { ...plan(stepAt(t), now), agents: v.shown }
  const look = STYLES[styleAt(t)]
  return look.draw(p as never, 301, now, v).height - look.draw(p as never, 301, now, null).height
}
const rowHOf = (p: unknown, w: number, look: (typeof STYLES)[StyleKey], now: number) => Math.max(22, look.draw(p as never, w, now, null).height) + 10
// where the rows and the input sit for a session at time t (UI units from the top of the bar area)
function layout(t: number, which: Which) {
  const now = 1_790_000_000_000 + t * 1000
  const v = viewOf(which, t, now)
  const look = STYLES[styleAt(t)]
  const grow = which === 'shop' ? growAt(t) : 0
  const c = which === 'bot' ? collapsedAt(t) : 0
  const barW = barWOf(v)
  const rowsH = v.away.reduce((h, r) => h + rowHOf(r.p, barW, look, now), 0)
  const awayY = 42 + grow - c * BAR_ROW
  const inputY = INPUT.y + grow - c * BAR_ROW + (rowsH + 6) * v.appear
  return { v, look, grow, c, barX: barXOf(v), barW, awayY, inputY, now }
}
const inWindow = (t: number, u: Pt): Pt => {
  const L = layout(t, whichAt(t))
  return { x: CARD_X + PAD + u.x * S, y: cardY(t) + PAD + (HEAD + (u.y >= INPUT.y ? u.y - INPUT.y + L.inputY : u.y)) * S }
}
// the middle of another session's title in the shop session, the press that switches to it
function awayTitlePt(t: number, folder: string): Pt {
  const L = layout(t, 'shop')
  let y = L.awayY + 6
  for (const r of L.v.away) {
    const h = rowHOf(r.p, L.barW, L.look, L.now)
    if (r.folder === folder) return { x: CARD_X + PAD + (14 + textW(titleOf(r), 13) / 2) * S, y: cardY(t) + PAD + (HEAD + y + h / 2) * S }
    y += h
  }
  throw new Error(`no row for ${folder}`)
}

// ---------- scene pieces ----------
// one session's bars: its own bar row, then the other sessions' rows under a hairline; its name sits above
function sessionContent(t: number, which: Which, hotFolder: string | null): string {
  const L = layout(t, which)
  const { v, look, grow, now } = L
  const p = v.own
  const drawnOwn = look.draw(p as never, L.barW, now, v.agents)
  const plainH = look.draw(p as never, L.barW, now, null).height
  const leave = which === 'bot' ? leavingAt(t) : 0
  const rowO = which === 'bot' ? 1 - ramp(t, T.sendClick + T.leave - 0.1, T.sendClick + T.leave + 0.05) : 1
  // the bar redraws when a step moves, when its style changes, on each subagent change,
  // and every second while subagents run (the plugin's clock ticks for their elapsed times)
  const stepMoves = [1, 2, 3, 4, 5].map(k => 2.2 + STEP_S * k)
  const agentTicks = Array.from({ length: Math.ceil(T.agentsFold - RUNS[0].at) }, (_, i) => RUNS[0].at + i + 1)
  const ownRedraws =
    which === 'shop'
      ? [T.uiIn, ...stepMoves, ...AGENT_EVENTS, ...agentTicks.filter(x => x < T.agentsFold), T.agentsFold, T.transitClick, T.stepTen, T.stepLast, T.allDone]
      : [T.botClick]
  const bar = drawnAt(lastOf(t, ownRedraws), `<svg width="${L.barW}" height="${36 + grow}" overflow="visible"><g transform="translate(0 ${(36 - plainH) / 2})">${drawnOwn.svg}</g></svg>`)
  const glyph = look.glyph(p as never)
  // a leaving bar's drawing fades; its title, glyph and count dim, as the plugin does
  const dim = leave > 0
  const own =
    rowO > 0
      ? [
          `<g opacity="${rowO}">`,
          glyph ? text(0, 23, glyph.char, 12, { fill: dim ? MUTED : glyph.color }) : '',
          text(14, 23, p.title, 13, { weight: 500, fill: dim ? MUTED : INK }),
          `<g transform="translate(${L.barX} 0)" opacity="${1 - leave}">${bar}</g>`,
          text(IN_W - 22, 23, look.right(p as never, now), 12, { fill: MUTED, anchor: 'end' }),
          text(IN_W - 6, 23, '✕', 11, { fill: MUTED, anchor: 'middle' }),
          `</g>`,
        ].join('')
      : ''
  // the other sessions' rows redraw when they appear, when one moves a step, when one finishes, and after a switch
  const awayRedraws = [T.crossIn, T.botDone, T.botClick, ...[1, 2, 3].map(i => T.crossIn + 2.6 * i)]
  let y = L.awayY + 6
  const rows = v.away
    .map(r => {
      const h = rowHOf(r.p, L.barW, look, now)
      const d = look.draw(r.p as never, L.barW, now, null)
      const cy = y + h / 2
      y += h
      const g = look.glyph(r.p as never)
      const isHot = hotFolder === r.folder
      return [
        g ? text(0, cy + 4.5, g.char, 12, { fill: g.color }) : '',
        // the title is the button that switches to that session
        text(14, cy + 4.5, titleOf(r), 13, { fill: isHot ? CLAY : INK }),
        `<g transform="translate(${L.barX} ${cy - d.height / 2})">${drawnAt(lastOf(t, awayRedraws), `<svg width="${L.barW}" height="${d.height}" overflow="visible">${d.svg}</svg>`)}</g>`,
        text(IN_W - 22, cy + 4.5, look.right(r.p as never, now), 12, { fill: MUTED, anchor: 'end' }),
        text(IN_W - 6, cy + 4.5, '✕', 11, { fill: MUTED, anchor: 'middle' }),
      ].join('')
    })
    .join('')
  const away = v.appear > 0 ? `<g opacity="${v.appear}"><rect x="0" y="${L.awayY}" width="${IN_W}" height="1" fill="${LINE}" opacity="${1 - L.c}"/>${rows}</g>` : ''
  const name = `<circle cx="4" cy="${-HEAD + 9}" r="3.5" fill="${CLAY}"/>` + text(13, -HEAD + 13, v.name, 11.5, { weight: 600, fill: MUTED })
  return name + own + away
}

function windowCard(t: number, gearHot: boolean, hotFolder: string | null): string {
  const which = whichAt(t)
  const L = layout(t, which)
  // the switch: the shop session slides out, then the bot session slides in, so the two never overlap
  const out = easeInOut((t - T.botClick) / (T.switchDur / 2))
  const inn = easeInOut((t - T.botClick - T.switchDur / 2) / (T.switchDur / 2))
  const contents =
    which === 'shop'
      ? sessionContent(t, 'shop', hotFolder)
      : [
          out < 1 ? `<g opacity="${1 - out}" transform="translate(${-24 * out} 0)">${sessionContent(T.botClick - 0.001, 'shop', 'bot')}</g>` : '',
          inn > 0 ? `<g opacity="${inn}" transform="translate(${24 * (1 - inn)} 0)">${sessionContent(t, 'bot', null)}</g>` : '',
        ].join('')
  const typed = typedAt(t)
  const isTyping = t >= T.inputClick && t < T.sendClick
  const caretOn = isTyping && Math.floor((t - T.inputClick) / 0.5) % 2 === 0
  const caretX = 14 + textW(typed, 13) + 1
  const dy = L.inputY - INPUT.y
  const gear = `<rect x="${GEAR_U.x - 10}" y="${GEAR_U.y - 10}" width="20" height="20" rx="5" fill="${NATIVE}"/>` + text(GEAR_U.x, GEAR_U.y + 4.5, '⚙︎', 12.5, { fill: gearHot ? CLAY : MUTED, anchor: 'middle' })
  const ui = [
    contents,
    `<g transform="translate(0 ${dy})">`,
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
  return `<rect x="${CARD_X}" y="${y}" width="${W - 2 * CARD_X}" height="${(HEAD + 150 + dy) * S}" rx="28" fill="${CARD}" stroke="${LINE}" stroke-width="2"/>
<g transform="translate(${CARD_X + PAD} ${y + PAD + HEAD * S}) scale(${S})">${ui}</g>`
}
// the reply above the card, as the transcript sits above the prompt: shop's streams in, bot's is already there
function transcript(t: number): string {
  const out = easeInOut((t - T.botClick) / (T.switchDur / 2))
  const inn = easeInOut((t - T.botClick - T.switchDur / 2) / (T.switchDur / 2))
  const y = cardY(t) - 40
  const line = (s: string, o: number) => (o > 0 && s ? `<g opacity="${o}"><circle cx="${CARD_X + 12}" cy="${y - 10}" r="7" fill="${CLAY}"/>${text(CARD_X + 32, y, s, 30)}</g>` : '')
  return line(replyAt(t), ramp(t, T.replyFrom, T.replyFrom + 0.15) * (1 - out)) + line(BOT_REPLY, inn)
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
// the other sessions switch, the subagent view with its preview, then one bordered tile per style
const PANE_STYLES: [StyleKey | 'original', string][] = [
  ['segments', '分段'],
  ['hairline', '細線'],
  ['beads', '串珠'],
  ['ledger', '刻度字'],
  ['transit', '路線圖'],
  ['original', '原版'],
]
const TILE_W = P_W - 24
const CROSS_Y = 77 // the other sessions switch
const AGENTS_LABEL_Y = 132
function paneLayout(style: StyleKey, now: number) {
  const agentsDrawn = STYLES[style].draw({ ...plan(5, now), id: 'preview-agents', agents: sampleAgents(now) } as never, P_W, now, { shown: sampleAgents(now), hidden: [] })
  const previews = PANE_STYLES.filter((e): e is [StyleKey, string] => e[0] !== 'original').map(([id]) => STYLES[id].draw({ ...plan(5, now), id: `preview-${id}` } as never, TILE_W, now, null))
  const slotH = Math.max(...previews.map(d => d.height))
  const agentsY = AGENTS_LABEL_Y + 27
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
    text(0, CROSS_Y, '其他 session', 13, { weight: 600 }),
    buttonRow(0, CROSS_Y + 5, ['開', '關'], 0),
    text(0, AGENTS_LABEL_Y, 'Subagent 顯示', 13, { weight: 600 }),
    buttonRow(0, AGENTS_LABEL_Y + 5, ['展開', '摘要', '隱藏'], 0),
    `<g transform="translate(0 ${L.agentsY + 8})">${drawnAt(paneDrawn, L.agentsDrawn.svg)}</g>`,
    text(0, L.listY + 4, '進度條樣式', 13, { weight: 600 }),
    ...tiles,
  ].join('')
  const y = panelTop(t)
  // the pane runs past the bottom of the frame, as a long pane scrolls
  return `<rect x="${CARD_X}" y="${y}" width="${W - 2 * CARD_X}" height="${H}" rx="28" fill="${CARD}" stroke="${LINE}" stroke-width="2"/>
<g transform="translate(${CARD_X + P_PAD} ${y + P_PAD}) scale(${SP})">${ui}</g>`
}
// the pane opens under the card, whose height is the bar row, the input and the footer while the pane is open
const panelTop = (t: number) => cardY(t) + (HEAD + 150 + layout(t, 'shop').inputY - INPUT.y) * S + PANEL_GAP
const inPanel = (t: number, u: Pt): Pt => ({ x: CARD_X + P_PAD + u.x * SP, y: panelTop(t) + P_PAD + u.y * SP })

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
  const bot = awayTitlePt(T.botClick - 0.001, 'bot')
  const input = inWindow(T.inputClick, { x: 150, y: INPUT.y + 26 })
  const send = inWindow(T.sendClick, { x: SEND.x + 2, y: SEND.y + 3 })
  const lerp = (a: Pt, b: Pt, e: number) => ({ x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e })
  const legs: [number[], Pt, Pt][] = [
    [T.gearMove, home, gear],
    [T.transitMove, gear, transit],
    [T.closeMove, transit, close],
    [T.botMove, close, bot],
    [T.inputMove, bot, input],
    [T.sendMove, input, send],
  ]
  let at = home
  for (const [[a, b], from, to] of legs) if (t >= a) at = lerp(from, to, ramp(t, a, b))
  const opacity = fade(t, T.gearMove[0] - 0.2, T.gearMove[0], T.cursorOut[0], T.cursorOut[1])
  if (opacity <= 0) return ''
  const ring = CLICKS.map(c => {
    const k = (t - c) / 0.4
    if (k < 0 || k > 1) return ''
    return `<circle cx="${at.x}" cy="${at.y}" r="${14 + 30 * easeOut(k)}" fill="none" stroke="${CLAY}" stroke-width="3" opacity="${(1 - k) * 0.7}"/>`
  }).join('')
  const press = CLICKS.some(c => t >= c && t < c + 0.12) ? 0.88 : 1
  return `<g opacity="${opacity}">${ring}<g transform="translate(${at.x} ${at.y}) scale(${1.7 * press})"><path d="M0 0 L0 21 L5.5 15.5 L9.5 24.5 L13 23 L9 14 L16.5 14 Z" fill="${INK}" stroke="#FFFFFF" stroke-width="1.6" stroke-linejoin="round"/></g></g>`
}
const CLICKS = [T.gearClick, T.transitClick, T.closeClick, T.botClick, T.inputClick, T.sendClick]

function frame(t: number): string {
  const style = styleAt(t)
  const titleO = 1 - ramp(t, T.titleOut, T.titleOut + 0.4)
  const uiO = fade(t, T.uiIn, T.uiIn + 0.4, T.uiOut, T.uiOut + 0.4)
  const panelO = fade(t, T.panelIn, T.panelIn + 0.35, T.panelOut, T.panelOut + 0.3)
  const panelDy = (1 - ramp(t, T.panelIn, T.panelIn + 0.35)) * 24 + ramp(t, T.panelOut, T.panelOut + 0.3) * 24
  const endO = ramp(t, T.endIn, T.endIn + 0.5)
  const [caption, capO] = captionAt(t)
  const gearHot = t > T.gearClick - 0.25 && t < T.gearClick + 0.4
  const hotFolder = t > T.botClick - 0.25 && t < T.botClick + 0.4 ? 'bot' : null
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
    parts.push(`<g opacity="${uiO}">`, text(W / 2, cardY(t) - 120, caption, 50, { weight: 700, anchor: 'middle', opacity: capO }), transcript(t), windowCard(t, gearHot, hotFolder), `</g>`)
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

// ---------- soundtrack: no music, only what really sounds ----------
// The mouse clicks, and the plugin's own done sound where the plugin plays it: once this session's reply is written.
// The plugin plays nothing when another session finishes, for subagents under a named bar, for typing or for the pane.
const SR = 44100
function soundtrack(): Float32Array[] {
  const n = Math.ceil(DURATION * SR)
  const L = new Float32Array(n)
  const Rt = new Float32Array(n)
  const add = (at: number, mono: Float32Array, gain: number) => {
    const o = Math.round(at * SR)
    for (let i = 0; i < mono.length && o + i < n; i++) {
      if (o + i < 0) continue
      L[o + i] += mono[i] * gain
      Rt[o + i] += mono[i] * gain
    }
  }
  const make = (sec: number, f: (t: number) => number) => Float32Array.from({ length: Math.round(sec * SR) }, (_, i) => f(i / SR))
  const env = (t: number, a: number, d: number) => (t < a ? t / a : Math.exp(-(t - a) / d))
  // white noise, repeatable
  let seed = 7
  const noise = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1
  const highpass = (x: Float32Array, cutoff: number) => {
    const k = 1 - Math.exp((-2 * Math.PI * cutoff) / SR)
    let y = 0
    return x.map(v => v - (y += k * (v - y)))
  }
  const readWav = (name: string) => {
    const buf = readFileSync(new URL(`../plugins/plan-progress/sounds/${name}.wav`, import.meta.url))
    const at = buf.indexOf('data') + 8 // 16-bit mono PCM, as the plugin ships them
    return Float32Array.from({ length: (buf.length - at) >> 1 }, (_, i) => buf.readInt16LE(at + i * 2) / 32768)
  }
  const click = () => highpass(make(0.04, t => (noise() * 0.6 + Math.sin(2 * Math.PI * 2400 * t)) * env(t, 0.0005, 0.006)), 900)
  for (const c of CLICKS) add(c, click(), 0.45)
  add(T.allDone, readWav('done'), 1)
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
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', `${FRAMES}/f%04d.png`, '-i', AUDIO, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', '-preset', 'slow', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', `${OUT_DIR}/plan-progress-promo.mp4`], { stdio: 'inherit' })
    console.log(`done: ${OUT_DIR}/plan-progress-promo.mp4`)
  }
}
