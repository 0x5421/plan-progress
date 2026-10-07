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

// ---------- palette and type ----------
// the backdrop and the title and end cards use the app's own colour tokens (read from Claude.app's bundle):
// bg-200 #F5F4ED, text-000 #141413, text-400 #73726C, brand-000 #C6613F.
// The window's colours are sampled from a real screenshot of the desktop app's Code tab.
const BG = '#F5F4ED'
const CARD = '#FFFFFF'
const INK = '#141413'
const INK2 = '#50504E' // icons and secondary labels
const MUTED = '#868681' // group headers, the percent beside a bar
const LINE = '#E5E5E5'
const CLAY = '#C6613F'
const NATIVE = '#EDEDEB' // the desktop's grey native button
const MAIN_BG = '#FCFCFC' // the conversation area
const SIDE = '#FAFAF8' // the sessions list
const SIDE_LINE = '#EBEBE9'
const SIDE_ON = '#EEEBEA' // the open session's row in the list
const SIDE_INK = '#50504E'
const HAIR = '#E2E2E0'
const BAND = '#F0F0F0' // the grey band the plugin's bars sit in, also the person's message
const INPUT_LINE = '#E2E2E2'
const PLACEHOLDER = '#888888'
const FOOT_INK = '#535350'
const TAG = '#E4E4E4'
const TAG_INK = '#545451'
const SEG = '#EFEFEC' // the chat / code switch in the title bar
const BADGE = '#CBE4FF' // the session's laptop badge
const BADGE_INK = '#2C84DB'
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
  if (t < 21.5) return ['點進度條標題，切到那個 session', fade(t, 19.0, 19.3, 21.2, 21.5)]
  return ['送出下一則，完成的進度條自動收起', fade(t, 21.6, 21.9, 24.4, 24.7)]
}

// ---------- layout (px) ----------
// The Claude desktop app's Code tab, measured from a real screenshot (2000 px wide, the window 1861 px):
// a title bar, the sessions list on the left, the open session on the right with its name, its conversation,
// the plugin's bars in a grey rounded band, the prompt and the footer. Drawn K times the screenshot's size in a
// window narrowed to the frame, as the app lays itself out in a narrow window.
const K = 1.1
const WIN = { x: 40, y: 360, w: 1000, h: 1220 }
const WIN_B = WIN.y + WIN.h
const TITLE_H = 66 * K
const SIDE_W = Math.round(358 * K)
const MAIN_X = WIN.x + SIDE_W
const MAIN_W = WIN.w - SIDE_W
const COL_X = MAIN_X + 26 // the conversation column, the band and the prompt share these edges
const COL_W = MAIN_W - 52
const COL_R = COL_X + COL_W
const BAND_PAD_X = 14
const BAND_PAD_Y = 9
const IN_W = 448 // UI units: the plugin's row inside the band
const UI_S = (COL_W - 2 * BAND_PAD_X) / IN_W
const INPUT_H = 54 * K
const INPUT_TOP = WIN_B - 47 * K - INPUT_H
const FOOT_Y = WIN_B - 22 * K // the footer's text baseline
const BAR_ROW = 48 // the bar's row, gone once the bar has left
const ROWS_GAP = 12 // UI units between the own row and the input in the plugin's own layout
const MODEL = 'Opus 5.5'
// the footer's right group, from the column's right edge (screenshot: gear 1500, model 1537, effort 1628, edge 1697)
const GEAR_PT = { x: COL_R - 197 * K, y: FOOT_Y - 6 * K }
const SEND_PT = { x: COL_R - 28 * K, y: INPUT_TOP + INPUT_H / 2 }
const INPUT_PT = { x: COL_X + 200, y: INPUT_TOP + INPUT_H / 2 }

// ---------- the sessions: shop (where the clip starts), bot (where it switches to), api (running throughout) ----------
type Which = 'shop' | 'bot'
type Row = { folder: string; p: ReturnType<typeof other> }
const titleOf = (r: Row) => `${r.folder} · ${r.p.title}`
const whichAt = (t: number): Which => (t < T.botClick ? 'shop' : 'bot')
// made-up projects and sessions; the list's own entries (新增, 成品…) are the app's
const SESSIONS: Record<Which | 'api', { title: string; folder: string }> = {
  shop: { title: '重構訂單模組', folder: 'shop' },
  bot: { title: '第 5 批回測', folder: 'bot' },
  api: { title: '部署上線', folder: 'api' },
}
function viewOf(which: Which, t: number, now: number) {
  const api: Row = { folder: 'api', p: other('api', '部署', API_STAGES, apiStepAt(t), false, now, 140_000) }
  const isBotDone = t >= T.botDone
  const bot = other('bot', '回測', BOT_STAGES, isBotDone ? 5 : 4, isBotDone, now, 410_000)
  if (which === 'shop') {
    const v = agentsAt(t, now)
    const own = { ...plan(stepAt(t), now, t >= T.allDone), ...(v ? { agents: v.shown } : {}) }
    // the plugin lists waiting sessions first, then finished, then running
    const away: Row[] = isBotDone ? [{ folder: 'bot', p: bot }, api] : [api, { folder: 'bot', p: bot }]
    return { own, agents: v, away, appear: ramp(t, T.crossIn, T.crossIn + 0.4) }
  }
  const shop = { ...plan(TOTAL_STEPS, now, true), id: 'shop' }
  return { own: bot, agents: null, away: [{ folder: 'shop', p: shop }, api] as Row[], appear: 1 }
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
// the rows inside the band for a session at time t (UI units from the band's inner top)
function layout(t: number, which: Which) {
  const now = 1_790_000_000_000 + t * 1000
  const v = viewOf(which, t, now)
  const look = STYLES[styleAt(t)]
  const grow = which === 'shop' ? growAt(t) : 0
  const c = which === 'bot' ? collapsedAt(t) : 0
  const barW = barWOf(v)
  const rowsH = v.away.reduce((h, r) => h + rowHOf(r.p, barW, look, now), 0)
  const awayY = 42 + grow - c * BAR_ROW
  const contentH = 36 + grow - c * BAR_ROW + (ROWS_GAP - 6 + rowsH) * v.appear + 6 * c * v.appear
  return { v, look, grow, c, barX: barXOf(v), barW, awayY, contentH: Math.max(0, contentH), now }
}
// the band sits on the prompt and grows upward as rows are added, as the app's does
const bandH = (t: number) => layout(t, whichAt(t)).contentH * UI_S + 2 * BAND_PAD_Y
const bandTop = (t: number) => INPUT_TOP - 10 * K - bandH(t)
// the middle of another session's title in the shop session, the press that switches to it
function awayTitlePt(t: number, folder: string): Pt {
  const L = layout(t, 'shop')
  let y = L.awayY + 6
  for (const r of L.v.away) {
    const h = rowHOf(r.p, L.barW, L.look, L.now)
    if (r.folder === folder) return { x: COL_X + BAND_PAD_X + (14 + textW(titleOf(r), 13) / 2) * UI_S, y: bandTop(t) + BAND_PAD_Y + (y + h / 2) * UI_S }
    y += h
  }
  throw new Error(`no row for ${folder}`)
}

// ---------- scene pieces ----------
// one session's bars: its own bar row, then the other sessions' rows under a hairline (UI units)
function sessionBars(t: number, which: Which, hotFolder: string | null): string {
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
          text(14, 23, p.title, 13, { fill: dim ? MUTED : INK }),
          `<g transform="translate(${L.barX} 0)" opacity="${1 - leave}">${bar}</g>`,
          text(IN_W - 22, 23, look.right(p as never, now), 12.5, { fill: MUTED, anchor: 'end' }),
          text(IN_W - 6, 23, '✕', 11, { fill: INK2, anchor: 'middle' }),
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
        text(14, cy + 4.5, titleOf(r), 13, { fill: isHot ? CLAY : INK, weight: isHot ? 600 : 400 }),
        `<g transform="translate(${L.barX} ${cy - d.height / 2})">${drawnAt(lastOf(t, awayRedraws), `<svg width="${L.barW}" height="${d.height}" overflow="visible">${d.svg}</svg>`)}</g>`,
        text(IN_W - 22, cy + 4.5, look.right(r.p as never, now), 12.5, { fill: MUTED, anchor: 'end' }),
        text(IN_W - 6, cy + 4.5, '✕', 11, { fill: INK2, anchor: 'middle' }),
      ].join('')
    })
    .join('')
  const away = v.appear > 0 ? `<g opacity="${v.appear}"><rect x="0" y="${L.awayY}" width="${IN_W}" height="1" fill="${HAIR}" opacity="${1 - L.c}"/>${rows}</g>` : ''
  return own + away
}

// what each session's conversation holds at time t: the app shows Claude's answers as plain text across the column;
// the person's own message is a right-aligned grey bubble (not in the reference screenshot, so its look is assumed)
const SHOP_ASK = '幫我重構訂單模組'
const SHOP_FIRST = '好，先讀現有模組，再拆成步驟動手。'
const BOT_ASK = '跑第 5 批回測'
const BOT_NEXT_REPLY = '好，開始跑第 6 批。'
const BODY = 17 * K
function conversation(t: number, which: Which): string {
  const y0 = WIN.y + TITLE_H + 40
  const bubble = (s: string, y: number, o = 1) => {
    const w = textW(s, BODY) + 36
    return o > 0 ? `<g opacity="${o}"><rect x="${COL_R - w}" y="${y}" width="${w}" height="${BODY + 26}" rx="16" fill="${BAND}"/>${text(COL_R - w + 18, y + BODY + 7, s, BODY)}</g>` : ''
  }
  const said = (s: string, y: number, o = 1) => (o > 0 && s ? `<g opacity="${o}">${text(COL_X, y + BODY, s, BODY)}</g>` : '')
  if (which === 'shop') return bubble(SHOP_ASK, y0) + said(SHOP_FIRST, y0 + 76) + said(replyAt(t), y0 + 120, ramp(t, T.replyFrom, T.replyFrom + 0.15))
  const sent = ramp(t, T.sendClick, T.sendClick + 0.25)
  return bubble(BOT_ASK, y0) + said(BOT_REPLY, y0 + 76) + bubble(MESSAGE, y0 + 130, sent) + said(BOT_NEXT_REPLY, y0 + 206, ramp(t, T.sendClick + 0.7, T.sendClick + 0.9))
}
// the open session's name in the title bar: a blue laptop badge, the name, a chevron and the project tag
function sessionHeader(which: Which): string {
  const s = SESSIONS[which]
  const cy = WIN.y + 33 * K
  const bx = MAIN_X + 18 * K
  const nameX = bx + 38 * K
  const nameEnd = nameX + textW(s.title, 17 * K)
  const tagX = nameEnd + 40 * K
  const tagW = textW(s.folder, 15 * K) + 14 * K
  return [
    `<rect x="${bx}" y="${cy - 16 * K}" width="${32 * K}" height="${32 * K}" rx="${8 * K}" fill="${BADGE}"/>`,
    // a laptop: screen and base
    `<rect x="${bx + 9 * K}" y="${cy - 7 * K}" width="${14 * K}" height="${10 * K}" rx="${1.5 * K}" fill="none" stroke="${BADGE_INK}" stroke-width="${1.8 * K}"/>`,
    `<path d="M${bx + 6 * K} ${cy + 6 * K} H${bx + 26 * K}" stroke="${BADGE_INK}" stroke-width="${1.8 * K}" stroke-linecap="round"/>`,
    text(nameX, cy + 6 * K, s.title, 17 * K, { weight: 500 }),
    `<path d="M${nameEnd + 12 * K} ${cy - 3 * K} l${5 * K} ${5 * K} l${5 * K} ${-5 * K}" fill="none" stroke="${INK2}" stroke-width="${1.6 * K}" stroke-linecap="round" stroke-linejoin="round"/>`,
    `<rect x="${tagX}" y="${cy - 13 * K}" width="${tagW}" height="${26 * K}" rx="${6 * K}" fill="${TAG}"/>`,
    text(tagX + 7 * K, cy + 5 * K, s.folder, 15 * K, { fill: TAG_INK }),
  ].join('')
}
// the title bar: traffic lights and the left icons over the list, the right icons over the main area
function titleBar(): string {
  const cy = WIN.y + 33 * K
  const dots = ['#FF5F57', '#FEBC2E', '#28C840'].map((c, i) => `<circle cx="${WIN.x + 31 * K + i * 29 * K}" cy="${cy}" r="${8 * K}" fill="${c}"/>`).join('')
  const ic = (x: number, d: string) => `<path transform="translate(${x} ${cy}) scale(${K})" d="${d}" fill="none" stroke="${INK2}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
  const lx = WIN.x
  const seg = `<rect x="${lx + 253 * K}" y="${cy - 17 * K}" width="${94 * K}" height="${34 * K}" rx="${9 * K}" fill="${SEG}"/><rect x="${lx + 302 * K}" y="${cy - 14 * K}" width="${42 * K}" height="${28 * K}" rx="${7 * K}" fill="#FFFFFF"/>`
  return [
    dots,
    ic(lx + 129 * K, 'M-8 -7 h16 v14 h-16 z M-3 -7 v14'), // sidebar
    ic(lx + 161 * K, 'M-2 -2 m-5 0 a5 5 0 1 0 10 0 a5 5 0 1 0 -10 0 M2 2 l5 5'), // search
    ic(lx + 194 * K, 'M5 0 h-11 M-1 -5 l-5 5 l5 5'), // back
    ic(lx + 226 * K, 'M-5 0 h11 M1 -5 l5 5 l-5 5'), // forward
    seg,
    ic(lx + 278 * K, 'M-7 -5 h10 v7 h-6 l-4 3 z M3 -1 h4 v7 l-3 -2 h-5'), // chat
    ic(lx + 323 * K, 'M-3 -5 l-5 5 l5 5 M3 -5 l5 5 l-5 5 M1 -6 l-2 12'), // code
    ic(WIN.x + WIN.w - 154 * K, 'M-7 -5 l5 5 l-5 5 M0 6 h7'), // terminal
    ic(WIN.x + WIN.w - 115 * K, 'M-7 -7 h14 v14 h-14 z M-3 0 l3 -3 l3 3 M0 -3 v7'), // panel
    ic(WIN.x + WIN.w - 74 * K, 'M-7 0 a7 7 0 1 0 14 0 a7 7 0 1 0 -14 0 M-7 0 h14 M0 -7 c-4 4 -4 10 0 14 c4 -4 4 -10 0 -14'), // globe
    `<g fill="${INK2}">${[-6, 0, 6].map(dy => `<circle cx="${WIN.x + WIN.w - 34 * K}" cy="${cy + dy * K}" r="${1.6 * K}"/>`).join('')}</g>`,
  ].join('')
}
// the left column: the app's own entries, then made-up projects with their sessions; the open one is highlighted
function sidebar(t: number): string {
  const x = WIN.x
  const top = WIN.y + TITLE_H
  const ix = x + 29 * K // icons
  const tx = x + 51 * K // text
  const f = 17 * K
  const nav = ['新增', '成品', '例行工作', '分派', '自訂', '更多']
  const navY = (i: number) => WIN.y + (159 - 69) * K + i * 36 * K
  const navItems = nav
    .map((s, i) => {
      const y = navY(i)
      const icon = i === 0 ? text(ix, y + 6 * K, '+', 18 * K, { fill: INK2, anchor: 'middle' }) : i === 5 ? text(ix, y + 5 * K, '›', 18 * K, { fill: MUTED, anchor: 'middle' }) : `<rect x="${ix - 7 * K}" y="${y - 7 * K}" width="${14 * K}" height="${14 * K}" rx="${3.5 * K}" fill="none" stroke="${INK2}" stroke-width="${1.5 * K}"/>`
      const beta = i === 3 ? `<rect x="${tx + textW(s, f) + 10 * K}" y="${y - 10 * K}" width="${46 * K}" height="${20 * K}" rx="${4 * K}" fill="${TAG}"/>${text(tx + textW(s, f) + 15 * K, y + 5 * K, '測試版', 12 * K, { fill: TAG_INK })}` : ''
      return icon + text(tx, y + 6 * K, s, f, { fill: i === 5 ? MUTED : SIDE_INK }) + beta
    })
    .join('')
  // made-up projects, each with one session
  const groups: { name: string; items: (Which | 'api')[] }[] = [
    { name: 'shop', items: ['shop'] },
    { name: 'bot', items: ['bot'] },
    { name: 'api', items: ['api'] },
  ]
  let y = WIN.y + (400 - 69) * K
  const itemY: Record<string, number> = {}
  const list = groups
    .map(g => {
      const head = text(x + 19 * K, y + 6 * K, g.name, 16 * K, { fill: MUTED }) + text(x + 330 * K, y + 7 * K, '+', 20 * K, { fill: MUTED, anchor: 'middle' })
      y += 37 * K
      const rows = g.items
        .map(id => {
          itemY[id] = y
          const r = `<circle cx="${ix}" cy="${y}" r="${3.5 * K}" fill="none" stroke="${MUTED}" stroke-width="${1.2 * K}"/>` + text(tx, y + 6 * K, SESSIONS[id].title, f, { fill: SIDE_INK })
          y += 37 * K
          return r
        })
        .join('')
      y += 16 * K
      return head + rows
    })
    .join('')
  // the highlight slides from shop to bot on the switch
  const hy = itemY.shop + (itemY.bot - itemY.shop) * easeInOut((t - T.botClick) / T.switchDur)
  const highlight = `<rect x="${x + 11 * K}" y="${hy - 18 * K}" width="${SIDE_W - 22 * K}" height="${36 * K}" rx="${8 * K}" fill="${SIDE_ON}"/>`
  // the account at the bottom: a made-up name
  const by = WIN_B - 29 * K
  const account = `<rect x="${x}" y="${by - 30 * K}" width="${SIDE_W}" height="1" fill="${HAIR}"/><circle cx="${ix}" cy="${by}" r="${13 * K}" fill="#C76A8E"/>` + text(tx, by + 6 * K, 'demo', f, { fill: SIDE_INK }) + text(tx + textW('demo', f) + 6 * K, by + 6 * K, '· Max', 15 * K, { fill: MUTED })
  return [
    `<rect x="${x}" y="${WIN.y}" width="${SIDE_W}" height="${WIN.h}" fill="${SIDE}"/>`,
    `<rect x="${x + SIDE_W - 1}" y="${top}" width="1" height="${WIN.h - TITLE_H}" fill="${SIDE_LINE}"/>`,
    navItems,
    highlight,
    list,
    account,
  ].join('')
}

function appWindow(t: number, gearHot: boolean, hotFolder: string | null): string {
  const which = whichAt(t)
  // the switch: the shop session slides out, then the bot session slides in, so the two never overlap
  const out = easeInOut((t - T.botClick) / (T.switchDur / 2))
  const inn = easeInOut((t - T.botClick - T.switchDur / 2) / (T.switchDur / 2))
  const band = (w: Which, at: number) => {
    const h = layout(at, w).contentH * UI_S + 2 * BAND_PAD_Y
    const top = INPUT_TOP - 10 * K - h
    return `<rect x="${COL_X}" y="${top}" width="${COL_W}" height="${h}" rx="${12 * K}" fill="${BAND}"/><g transform="translate(${COL_X + BAND_PAD_X} ${top + BAND_PAD_Y}) scale(${UI_S})">${sessionBars(at, w, w === 'shop' ? hotFolder : null)}</g>`
  }
  const main = (w: Which, at: number) => sessionHeader(w) + conversation(at, w) + band(w, at)
  const contents =
    which === 'shop'
      ? main('shop', t)
      : [
          out < 1 ? `<g opacity="${1 - out}" transform="translate(${-30 * out} 0)">${main('shop', T.botClick - 0.001)}</g>` : '',
          inn > 0 ? `<g opacity="${inn}" transform="translate(${30 * (1 - inn)} 0)">${main('bot', t)}</g>` : '',
        ].join('')
  const typed = typedAt(t)
  const isTyping = t >= T.inputClick && t < T.sendClick
  const caretOn = isTyping && Math.floor((t - T.inputClick) / 0.5) % 2 === 0
  const ty = INPUT_TOP + INPUT_H / 2 + 6 * K
  const caretX = COL_X + 17 * K + textW(typed, BODY) + 2
  const ic = (x: number, y: number, d: string, c = INK2) => `<path transform="translate(${x} ${y}) scale(${K})" d="${d}" fill="none" stroke="${c}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
  // the prompt: a white field with a return key, then the footer
  const prompt = [
    `<rect x="${COL_X}" y="${INPUT_TOP}" width="${COL_W}" height="${INPUT_H}" rx="${12 * K}" fill="#FFFFFF" stroke="${isTyping ? '#C9C9C9' : INPUT_LINE}" stroke-width="1.5"/>`,
    typed ? text(COL_X + 17 * K, ty, typed, BODY) : text(COL_X + 17 * K, ty, '請 Claude 幫你…', BODY, { fill: PLACEHOLDER }),
    caretOn ? `<rect x="${caretX}" y="${ty - BODY + 1}" width="1.6" height="${BODY + 3}" fill="${INK}"/>` : '',
    ic(SEND_PT.x, SEND_PT.y, 'M6 -5 v5 h-12 M-3 -3 l-3 3 l3 3', typed ? INK : MUTED),
    text(COL_X + 23 * K, FOOT_Y, '+', 19 * K, { fill: INK2, anchor: 'middle' }),
    ic(COL_X + 50 * K, FOOT_Y - 6 * K, 'M0 -6 a2.5 2.5 0 0 1 2.5 2.5 v4 a2.5 2.5 0 0 1 -5 0 v-4 a2.5 2.5 0 0 1 2.5 -2.5 M-5 0 a5 5 0 0 0 10 0 M0 5 v3'),
    ic(COL_X + 76 * K, FOOT_Y - 6 * K, 'M-3 -1 l3 3 l3 -3'),
    text(COL_X + 98 * K, FOOT_Y, '略過權限確認', 15 * K, { fill: FOOT_INK }),
    // the plugin's gear: the desktop draws it as a small grey native button
    `<rect x="${GEAR_PT.x - 9 * K}" y="${GEAR_PT.y - 9 * K}" width="${18 * K}" height="${18 * K}" rx="${4 * K}" fill="${gearHot ? '#E2DCD6' : NATIVE}"/>`,
    text(GEAR_PT.x, GEAR_PT.y + 4.5 * K, '⚙︎', 12 * K, { fill: gearHot ? CLAY : '#92928F', anchor: 'middle' }),
    text(COL_R - 160 * K, FOOT_Y, MODEL, 16 * K, { fill: INK }),
    text(COL_R - 69 * K, FOOT_Y, '高', 16 * K, { fill: INK }),
  ].join('')
  return [
    `<rect x="${WIN.x}" y="${WIN.y}" width="${WIN.w}" height="${WIN.h}" rx="${24 * K}" fill="${MAIN_BG}"/>`,
    `<clipPath id="win"><rect x="${WIN.x}" y="${WIN.y}" width="${WIN.w}" height="${WIN.h}" rx="${24 * K}"/></clipPath>`,
    `<g clip-path="url(#win)">`,
    sidebar(t),
    titleBar(),
    contents,
    prompt,
    `</g>`,
    `<rect x="${WIN.x}" y="${WIN.y}" width="${WIN.w}" height="${WIN.h}" rx="${24 * K}" fill="none" stroke="#00000022" stroke-width="1.5"/>`,
  ].join('')
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
// the other sessions switch, the subagent view with its preview, then one bordered tile per style.
// It opens over the conversation, so the bars under it stay in sight while a style is picked.
const PANE_STYLES: [StyleKey | 'original', string][] = [
  ['segments', '分段'],
  ['hairline', '細線'],
  ['beads', '串珠'],
  ['ledger', '刻度字'],
  ['transit', '路線圖'],
  ['original', '原版'],
]
const P_X = MAIN_X + 12
const P_TOP = WIN.y + TITLE_H + 12
const P_PAD = 18
const P_W = 470 // UI units
const SP = (MAIN_W - 24 - 2 * P_PAD) / P_W
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
// the pane's bottom edge: just above the bars
const paneBottom = (t: number) => bandTop(t) - 14
// the pane is taller than the room above the bars: it scrolls down to the transit tile, then back up to save and close
function paneScroll(t: number) {
  const now = 1_790_000_000_000 + t * 1000
  const L = paneLayout('beads', now)
  const room = (paneBottom(t) - P_TOP - 2 * P_PAD) / SP
  const need = Math.max(0, L.tileY(4) + L.tileH + 10 - room)
  return need * (ramp(t, T.panelIn + 0.4, T.transitMove[0]) - ramp(t, T.transitClick + 0.3, T.closeMove[0]))
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
  const h = paneBottom(t) - P_TOP
  // a long pane scrolls: what does not fit under the bars' edge is cut off
  return `<clipPath id="pane"><rect x="${P_X}" y="${P_TOP}" width="${MAIN_W - 24}" height="${h}" rx="18"/></clipPath>
<rect x="${P_X}" y="${P_TOP}" width="${MAIN_W - 24}" height="${h}" rx="18" fill="${CARD}" stroke="${INK}" stroke-opacity=".18" stroke-width="2"/>
<g clip-path="url(#pane)"><g transform="translate(${P_X + P_PAD} ${P_TOP + P_PAD - paneScroll(t) * SP}) scale(${SP})">${ui}</g></g>`
}
const inPanel = (t: number, u: Pt): Pt => ({ x: P_X + P_PAD + u.x * SP, y: P_TOP + P_PAD + (u.y - paneScroll(t)) * SP })

function cursor(t: number): string {
  const now = 1_790_000_000_000 + t * 1000
  const home = { x: 940, y: 1760 }
  // where each press lands, read at the moment of the press so the cursor meets the button there
  const gear = GEAR_PT
  const tileAt = (i: number, style: StyleKey, at: number) => {
    const b = paneLayout(style, now).useBtn(i, false)
    return inPanel(at, { x: b.x + btnW('使用') - 4, y: b.y + 13 })
  }
  const transit = tileAt(4, 'beads', T.transitClick)
  const close = inPanel(T.closeClick, { x: P_W - 14, y: 22 + 12 })
  const bot = awayTitlePt(T.botClick - 0.001, 'bot')
  const input = INPUT_PT
  const send = SEND_PT
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
    parts.push(`<g opacity="${uiO}">`, text(W / 2, WIN.y - 70, caption, 50, { weight: 700, anchor: 'middle', opacity: capO }), appWindow(t, gearHot, hotFolder))
    if (panelO > 0) parts.push(`<g opacity="${panelO}" transform="translate(0 ${panelDy})">`, panelCard(t, style), `</g>`)
    parts.push(`</g>`)
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
