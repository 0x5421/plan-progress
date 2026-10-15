// Renders the landscape promo (1920x1080, 60 fps, about 46 s) frame by frame with the plugin's own drawing code,
// captures each frame in headless Chrome over the DevTools protocol, then joins them with ffmpeg.
// Run: node --experimental-strip-types promo/make-promo.mts [outDir] [--stills=8,20,30]
// --stills writes only those moments as PNGs into outDir/stills, to check a layout without the full render.
// The beats follow the usual launch-video shape: a problem in one line, the name, three to five feature demos of a few
// seconds each with one caption and one cue (a zoom or the cursor) at a time, then one call to action. No voice: the
// captions carry it, and the only sounds are the clicks and the plugin's own done sound where the plugin plays it.
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { STYLES, setAccent } from '../plugins/plan-progress/hooks/styles.ts'

type StyleKey = keyof typeof STYLES
// the glyph, the running row, the status word and the frame's name are drawn in register.tsx, which only runs in
// Claude Code; those functions and the constants they read are lifted from it, so the video draws what the plugin draws
function lift(): { glyphSvg: (c: string, col: string) => string; runningSvg: (l: string, W: number, col: string) => string; statusSvg: (w: string, W: number) => string; frameNameSvg: (s: string) => { svg: string; width: number }; FRAME_NAME_H: number; FRAME_ROW_PX: number } {
  const src = readFileSync(new URL('../plugins/plan-progress/hooks/register.tsx', import.meta.url), 'utf8')
  const pick = (re: RegExp) => {
    const m = src.match(re)
    if (!m) throw new Error(`register.tsx no longer has ${re}`)
    return m[0]
  }
  const block = (start: string) => {
    const i = src.indexOf(start)
    if (i < 0) throw new Error(`register.tsx no longer has ${start}`)
    return src.slice(i, src.indexOf('\n}\n', i) + 3)
  }
  const parts = [
    pick(/^const STATE_COLOR: .*$/m),
    pick(/^const TRACK_H = .*$/m),
    pick(/^const esc = .*$/m),
    pick(/^const textWidth = .*$/m),
    pick(/^const GLYPH_W = .*$/m),
    pick(/^const GLYPH_H = .*$/m),
    block('function glyphSvg('),
    pick(/^const statusSvg = [\s\S]*?<\/svg>`\n/m),
    block('function runningSvg('),
    pick(/^const FRAME_ROW_PX = .*$/m),
    pick(/^const FRAME_NAME_H = .*$/m),
    block('function frameNameSvg('),
  ]
  return new Function(`${stripTypeScriptTypes(parts.join('\n'))}\nreturn { glyphSvg, runningSvg, statusSvg, frameNameSvg, FRAME_NAME_H, FRAME_ROW_PX }`)()
}
const P = lift()

const args = process.argv.slice(2)
const stillsArg = args.find(a => a.startsWith('--stills='))
const STILLS = stillsArg ? stillsArg.slice('--stills='.length).split(',').map(Number) : null
const OUT_DIR = args.find(a => !a.startsWith('--')) ?? new URL('./out-v2', import.meta.url).pathname
const FRAMES = STILLS ? `${OUT_DIR}/stills` : `${OUT_DIR}/frames`
const W = 1920
const H = 1080
const FPS = 60
const DURATION = 46

// ---------- palette and type (the app's own tokens, as in make-video.mts) ----------
const BG = '#F5F4ED'
const CARD = '#FFFFFF'
const INK = '#141413'
const INK2 = '#50504E'
const MUTED = '#868681'
const LINE = '#E5E5E5'
const CLAY = '#C6613F'
const MAIN_BG = '#FCFCFC'
const SIDE = '#FAFAF8'
const SIDE_LINE = '#EBEBE9'
const SIDE_ON = '#EEEBEA'
const SIDE_INK = '#50504E'
const HAIR = '#E2E2E0'
const BAND = '#F0F0F0'
const INPUT_LINE = '#E2E2E2'
const PLACEHOLDER = '#888888'
const FOOT_INK = '#535350'
const NATIVE = '#EDEDEB'
const FONT = "-apple-system,BlinkMacSystemFont,'PingFang TC','Helvetica Neue',sans-serif"
const MONO = "ui-monospace,'SF Mono',Menlo,monospace"

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v))
const easeOut = (x: number) => 1 - Math.pow(1 - clamp(x), 4)
const easeInOut = (x: number) => (clamp(x) < 0.5 ? 8 * clamp(x) ** 4 : 1 - Math.pow(-2 * clamp(x) + 2, 4) / 2)
const ramp = (t: number, a: number, b: number) => easeOut((t - a) / (b - a))
const fade = (t: number, inA: number, inB: number, outA = Infinity, outB = Infinity) => Math.min(ramp(t, inA, inB), 1 - ramp(t, outA, outB))
const text = (x: number, y: number, s: string, size: number, o: { fill?: string; weight?: number; anchor?: string; opacity?: number; font?: string } = {}) =>
  `<text x="${x}" y="${y}" font-family="${o.font ?? FONT}" font-size="${size}" font-weight="${o.weight ?? 400}" fill="${o.fill ?? INK}" text-anchor="${o.anchor ?? 'start'}" opacity="${o.opacity ?? 1}">${esc(s)}</text>`
const textW = (s: string, size: number) => [...s].reduce((w, ch) => w + (/[　-鿿＀-￯]/.test(ch) ? size : size * 0.56), 0)
type Pt = { x: number; y: number }
const lerp = (a: number, b: number, e: number) => a + (b - a) * e

// each drawing gets its own id prefix: a whole frame is one page, and the drawings' fixed ids would collide
let drawingN = 0
const scopeIds = (svg: string) => {
  const k = `d${drawingN++}-`
  return svg.replace(/\bid="([^"]+)"/g, `id="${k}$1"`).replace(/url\(#([^)]+)\)/g, `url(#${k}$1)`).replace(/href="#([^"]+)"/g, `href="#${k}$1"`)
}
// Claude Code swaps in a new picture whenever the plugin redraws and its animations start over; data-start marks that
const drawnAt = (start: number, svg: string) => `<g data-start="${start}">${scopeIds(svg)}</g>`
const lastOf = (t: number, times: number[]) => Math.max(...times.filter(x => x <= t), 0)
const NOW0 = 1_790_000_000_000

// ---------- the plans (made-up projects; no real session names) ----------
type Step = { title: string; status: 'done' | 'active' | 'pending' }
function stagesAt(stages: [string, string[]][], k: number) {
  let i = 0
  return stages.map(([name, ts]) => ({
    name,
    steps: ts.map(title => {
      const idx = i++
      return { title, substeps: [], status: (idx < k ? 'done' : idx === k ? 'active' : 'pending') as Step['status'] }
    }),
  }))
}
const SHOP: [string, string[]][] = [
  ['Analysis', ['讀現有模組', '找相依關係', '列出改動']],
  ['Build', ['資料表結構', '寫遷移', '搬資料']],
  ['Test', ['單元測試', '整合測試']],
  ['Ship', ['打包', '發佈']],
]
const SHOP_N = SHOP.reduce((n, [, s]) => n + s.length, 0)
const BOT: [string, string[]][] = [
  ['Data', ['抓資料', '清資料']],
  ['Run', ['跑回測', '算績效']],
  ['Report', ['寫報告']],
]
const plan = (id: string, title: string, stages: unknown, state: 'running' | 'done', ago: number, now: number) => ({ id, title, kind: 'plan' as const, state, note: null, startedAt: now - ago, stages })

// ---------- timeline (seconds) ----------
const T = {
  hookIn: 0.2,
  hookOut: 3.4,
  titleIn: 3.6,
  titleOut: 6.2,
  uiIn: 6.4,
  barIn: 7.6, // the first plan call: the bar appears
  zoomIn: [8.2, 9.2],
  agentsIn: 10.2,
  agentsFold: 13.4,
  stepLast: 14.2, // every step ticked: the bar holds while Claude writes its reply
  replyFrom: 14.4,
  replyTo: 16.0,
  allDone: 16.3, // the reply is written: Done, and the done sound
  zoomOut: [17.4, 18.4],
  crossIn: 18.6, // the other sessions show under this one, this session's bars framed
  crossZoom: [19.0, 20.0],
  botMove: [22.6, 23.4],
  botClick: 23.5, // its title is pressed: the app switches to that session
  switchDur: 0.5,
  crossZoomOut: [24.2, 25.0],
  gearMove: [25.6, 26.3],
  gearClick: 26.4,
  paneIn: 26.5,
  beadsMove: [27.6, 28.3],
  beadsClick: 28.4,
  tealMove: [29.6, 30.3],
  tealClick: 30.4,
  closeMove: [31.6, 32.2],
  closeClick: 32.3,
  paneOut: 32.4,
  skipped: 33.6, // the bot session moves on past a step it leaves for later
  skipZoom: [34.0, 35.0],
  skipZoomOut: [39.0, 40.0],
  cursorOut: [32.6, 33.0],
  uiOut: 40.4,
  endIn: 40.9,
}
const CLICKS = [T.botClick, T.gearClick, T.beadsClick, T.tealClick, T.closeClick]
const captionAt = (t: number): [string, string, number] => {
  if (t < T.agentsIn) return ['每一步都看得見', 'Claude 一接到多步驟任務，就在輸入框上方畫出進度條', fade(t, T.uiIn + 0.6, T.uiIn + 1.0, T.agentsIn - 0.3, T.agentsIn)]
  if (t < T.stepLast) return ['Subagent 在做什麼也看得到', '每個子代理一條狀態列：在跑、等你核准、做完', fade(t, T.agentsIn, T.agentsIn + 0.4, T.stepLast - 0.3, T.stepLast)]
  if (t < T.crossIn - 0.2) return ['回覆寫完，才亮 Done、才響完成音', '不會在 Claude 還在打字時就先響', fade(t, T.stepLast, T.stepLast + 0.4, T.crossIn - 0.5, T.crossIn - 0.2)]
  if (t < T.botMove[0]) return ['所有 session，一眼掌握', '自己的框起來；其他在跑、跑完、正在做什麼都列在下面', fade(t, T.crossIn, T.crossIn + 0.4, T.botMove[0] - 0.3, T.botMove[0])]
  if (t < T.gearMove[0]) return ['點標題，直接切過去', '切過去看過的完成通知，所有 session 同步收起', fade(t, T.botMove[0], T.botMove[0] + 0.4, T.gearMove[0] - 0.3, T.gearMove[0])]
  if (t < T.skipped) return ['換樣式、換顏色，點一下就套用', '點右上角 ⚙ 打開面板；共七種樣式、六種顏色', fade(t, T.gearMove[0], T.gearMove[0] + 0.4, T.skipped - 0.3, T.skipped)]
  return ['跳著做，也標得清清楚楚', '先擱著的步驟畫成虛線，步數只算真的做完的', fade(t, T.skipped, T.skipped + 0.4, T.uiOut - 0.3, T.uiOut)]
}

// three subagents under the bar: one waits for approval, all finish, then their strips fold away
type RunState = 'running' | 'waiting' | 'done'
const RUNS: { id: string; title: string; at: number; steps: [number, RunState, string][] }[] = [
  { id: 'a1', title: '讀取模組', at: 10.2, steps: [[10.2, 'running', 'Read'], [11.2, 'running', 'Grep'], [12.4, 'done', 'Done']] },
  { id: 'a2', title: '量 API 延遲', at: 10.5, steps: [[10.5, 'running', 'Bash'], [11.8, 'done', 'Done']] },
  { id: 'a3', title: '比對打包大小', at: 10.8, steps: [[10.8, 'running', 'Read'], [11.4, 'waiting', 'Needs approval'], [12.2, 'running', 'Bash'], [12.9, 'done', 'Done']] },
]
const AGENT_PACE = 14_000
const AGENT_EVENTS = RUNS.flatMap(r => r.steps.map(([at]) => at))
function agentsAt(t: number, now: number) {
  if (t < T.agentsIn || t >= T.agentsFold) return null
  const shown = RUNS.filter(r => t >= r.at).map(r => {
    const [, state, tool] = [...r.steps].reverse().find(([at]) => t >= at) ?? r.steps[0]
    const ended = state === 'done' ? r.steps[r.steps.length - 1][0] : null
    return { id: r.id, title: r.title, state, tool, startedAt: now - (t - r.at) * AGENT_PACE, endedAt: ended === null ? null : now - (t - ended) * AGENT_PACE, depth: 0 }
  })
  return shown.length ? { shown, hidden: [] } : null
}
// the shop bar's step: one every 0.6 s from the first call, all ticked at stepLast
const STEP_TIMES = Array.from({ length: SHOP_N - 1 }, (_, i) => T.barIn + 0.6 + i * ((T.stepLast - T.barIn - 0.8) / (SHOP_N - 1)))
const shopStepAt = (t: number) => (t >= T.stepLast ? SHOP_N : STEP_TIMES.filter(x => x <= t).length)
const styleAt = (t: number): StyleKey => (t < T.beadsClick ? 'segments' : 'beads')
const accentAt = (t: number) => (t < T.tealClick ? null : 'teal')
const REPLY = '重構完成：四個階段都跑完，測試全數通過。'
const replyAt = (t: number) => REPLY.slice(0, Math.round(REPLY.length * clamp((t - T.replyFrom) / (T.replyTo - T.replyFrom))))

// ---------- layout ----------
const WIN = { x: 150, y: 170, w: 1620, h: 830 }
const WIN_B = WIN.y + WIN.h
const TITLE_H = 66
const SIDE_W = 330
const MAIN_X = WIN.x + SIDE_W
const MAIN_W = WIN.w - SIDE_W
const COL_X = MAIN_X + 60
const COL_W = MAIN_W - 120
const COL_R = COL_X + COL_W
const INPUT_H = 58
const INPUT_TOP = WIN_B - 52 - INPUT_H
const FOOT_Y = WIN_B - 22
const BAND_PAD_X = 16
const BAND_PAD_Y = 12
const UI_S = 1.45 // the plugin draws in CSS px; the band is shown a little larger than life so it reads on video
const IN_W = (COL_W - 2 * BAND_PAD_X) / UI_S
const GEAR_W = 24 // the gear's column at the band's right (3 cells)
const ROW_H = 34
const ROW_GAP = 8
const FRAME_PAD = 10

// ---------- sessions ----------
type Which = 'shop' | 'bot'
const whichAt = (t: number): Which => (t < T.botClick ? 'shop' : 'bot')
const SESSIONS = {
  shop: { title: '重構訂單模組', folder: 'shop' },
  bot: { title: '第 5 批回測', folder: 'bot' },
  api: { title: '部署上線', folder: 'api' },
  notes: { title: '週報整理', folder: 'notes' },
}
type Row =
  | { kind: 'bar'; key: string; title: string; p: ReturnType<typeof plan> }
  | { kind: 'run'; key: string; title: string; tool: string; since: number }
  | { kind: 'done'; key: string; title: string }

function botPlan(t: number, now: number) {
  if (t < T.skipped) return plan('bot', '第 5 批回測', stagesAt(BOT, 2), 'running', 410_000, now)
  // the bot session left 清資料 for later and is on 算績效
  const stages = [
    { name: 'Data', steps: [{ title: '抓資料', substeps: [], status: 'done' }, { title: '清資料', substeps: [], status: 'pending' }] },
    { name: 'Run', steps: [{ title: '跑回測', substeps: [], status: 'done' }, { title: '算績效', substeps: [], status: 'active' }] },
    { name: 'Report', steps: [{ title: '寫報告', substeps: [], status: 'pending' }] },
  ]
  return plan('bot', '第 5 批回測', stages, 'running', 410_000, now)
}
function viewOf(which: Which, t: number, now: number) {
  const api: Row = { kind: 'run', key: 'api', title: SESSIONS.api.title, tool: '執行指令 · Bash', since: now - 72_000 - (t - T.crossIn) * 1000 }
  const notes: Row = { kind: 'done', key: 'notes', title: SESSIONS.notes.title }
  if (which === 'shop') {
    const v = agentsAt(t, now)
    const own = { ...plan('shop', '重構訂單模組', stagesAt(SHOP, shopStepAt(t)), t >= T.allDone ? 'done' : 'running', 192_000, now), ...(v ? { agents: v.shown } : {}) }
    const bot: Row = { kind: 'bar', key: 'bot', title: SESSIONS.bot.title, p: botPlan(t, now) }
    // waiting on the person first, then finished, then running
    return { own, agents: v, away: [notes, bot, api] as Row[], appear: ramp(t, T.crossIn, T.crossIn + 0.5) }
  }
  const shop: Row = { kind: 'bar', key: 'shop', title: SESSIONS.shop.title, p: plan('shop', '重構訂單模組', stagesAt(SHOP, SHOP_N), 'done', 200_000, now) }
  return { own: botPlan(t, now), agents: null, away: [notes, shop, api] as Row[], appear: 1 }
}
const titleColW = (v: ReturnType<typeof viewOf>) => Math.max(textW(v.own.title, 13), ...v.away.map(r => textW(r.title, 13)))
const barXOf = (v: ReturnType<typeof viewOf>) => 18 + titleColW(v) + 14
const RIGHT_W = 52
const barWOf = (v: ReturnType<typeof viewOf>) => IN_W - GEAR_W - barXOf(v) - RIGHT_W - 22

// the rows inside the band (UI units from the band's inner top)
function layout(t: number, which: Which) {
  const now = NOW0 + t * 1000
  setAccent(accentAt(t))
  const v = viewOf(which, t, now)
  const look = STYLES[styleAt(t)]
  const barW = barWOf(v)
  const ownD = look.draw(v.own as never, barW, now, v.agents)
  const ownH = Math.max(ROW_H, ownD.height + 12)
  const framed = v.appear > 0
  const framePad = framed ? FRAME_PAD * v.appear : 0
  const ownTop = framePad
  const awayTop = ownTop + ownH + framePad + (framed ? ROW_GAP + 6 : 0)
  const rowsH = v.away.length * (ROW_H + ROW_GAP)
  const contentH = awayTop - (framed ? 0 : ROW_GAP + 6) + rowsH * v.appear
  return { v, look, now, barW, barX: barXOf(v), ownD, ownH, ownTop, awayTop, framed, framePad, contentH }
}
const bandHOf = (t: number, w: Which) => layout(t, w).contentH * UI_S + 2 * BAND_PAD_Y
const bandTopOf = (t: number, w: Which) => INPUT_TOP - 12 - bandHOf(t, w)
const rowPt = (t: number, which: Which, key: string): Pt => {
  const L = layout(t, which)
  const i = L.v.away.findIndex(r => r.key === key)
  const y = L.awayTop + i * (ROW_H + ROW_GAP) + ROW_H / 2
  const r = L.v.away[i]
  return { x: COL_X + BAND_PAD_X + (18 + textW(r.title, 13) / 2) * UI_S, y: bandTopOf(t, which) + BAND_PAD_Y + y * UI_S }
}
const gearPt = (t: number, which: Which): Pt => ({ x: COL_X + BAND_PAD_X + (IN_W - GEAR_W / 2) * UI_S, y: bandTopOf(t, which) + BAND_PAD_Y + (layout(t, which).ownTop + ROW_H / 2) * UI_S })

// ---------- the band: this session's bars (framed, its name on the line), the others under them, the gear ----------
function band(t: number, which: Which, hot: string | null): string {
  const L = layout(t, which)
  const { v, look, now } = L
  const p = v.own
  const h = L.contentH * UI_S + 2 * BAND_PAD_Y
  const top = INPUT_TOP - 12 - h
  // the bar redraws on each step, each subagent change and every second while they run, on a style or colour change
  const ownRedraws = which === 'shop' ? [T.barIn, ...STEP_TIMES, ...AGENT_EVENTS, T.agentsFold, T.stepLast, T.allDone] : [T.botClick, T.beadsClick, T.tealClick, T.skipped]
  const glyph = look.glyph(p as never)
  const rowY = (y: number, hh: number) => y + hh / 2
  const cyOwn = rowY(L.ownTop, ROW_H)
  const ownBar = `<g transform="translate(${L.barX} ${L.ownTop + (ROW_H - Math.min(L.ownD.height, ROW_H)) / 2})">${drawnAt(lastOf(t, ownRedraws), L.ownD.svg)}</g>`
  const parts: string[] = []
  if (L.framed) {
    const fy = L.ownTop - L.framePad * 0.6
    const fh = L.ownH + L.framePad * 1.2
    parts.push(`<rect x="-6" y="${fy}" width="${IN_W - GEAR_W + 2}" height="${fh}" rx="10" fill="none" stroke="#000" stroke-opacity="${0.16 * v.appear}" stroke-width="1"/>`)
    // this session's name on the frame's top line, the plugin's own drawing
    const name = P.frameNameSvg(SESSIONS[which].title)
    parts.push(`<g opacity="${v.appear}" transform="translate(6 ${fy - P.FRAME_ROW_PX})">${name.svg}</g>`)
  }
  parts.push(glyph ? `<g transform="translate(0 ${cyOwn - 8})">${P.glyphSvg(glyph.char, glyph.color)}</g>` : '')
  parts.push(text(18, cyOwn + 4.5, p.title, 13))
  parts.push(ownBar)
  parts.push(text(IN_W - GEAR_W - 24, cyOwn + 4.5, look.right(p as never, now), 12, { fill: MUTED, anchor: 'end' }))
  parts.push(text(IN_W - GEAR_W - 8, cyOwn + 4.5, '✕', 11, { fill: INK2, anchor: 'middle' }))
  // the gear: its own column at the top right, a small native button
  const gx = IN_W - GEAR_W / 2
  const gearHot = t > T.gearClick - 0.25 && t < T.gearClick + 0.4
  parts.push(`<rect x="${gx - 9}" y="${cyOwn - 9}" width="18" height="18" rx="4" fill="${gearHot ? '#E2DCD6' : NATIVE}"/>`)
  parts.push(text(gx, cyOwn + 4, '⚙︎', 11, { fill: gearHot ? CLAY : '#92928F', anchor: 'middle' }))
  if (v.appear > 0) {
    const awayRedraws = [T.crossIn, T.botClick, T.beadsClick, T.tealClick, T.skipped]
    const rows = v.away
      .map((r, i) => {
        const cy = L.awayTop + i * (ROW_H + ROW_GAP) + ROW_H / 2
        const isHot = hot === r.key
        let g = ''
        let body = ''
        let right = ''
        if (r.kind === 'bar') {
          const gl = look.glyph(r.p as never)
          g = gl ? P.glyphSvg(gl.char, gl.color) : ''
          const d = look.draw(r.p as never, L.barW, now, null)
          body = `<g transform="translate(${L.barX} ${cy - d.height / 2})">${drawnAt(lastOf(t, awayRedraws), d.svg)}</g>`
          right = look.right(r.p as never, now)
        } else if (r.kind === 'run') {
          const gl = look.glyph({ state: 'running' } as never)
          g = gl ? P.glyphSvg(gl.char, gl.color) : ''
          body = `<g transform="translate(${L.barX} ${cy - 11})">${drawnAt(lastOf(t, awayRedraws), P.runningSvg(r.tool, L.barW, gl?.color ?? '#8B7CF6'))}</g>`
          const sec = Math.max(0, Math.round((now - r.since) / 1000))
          right = `${Math.floor(sec / 60)}m ${sec % 60}s`
        } else {
          g = P.glyphSvg('✓', '#30A46C')
          body = `<g transform="translate(${L.barX} ${cy - 11})">${P.statusSvg('跑完了', L.barW)}</g>`
        }
        return [
          g ? `<g transform="translate(0 ${cy - 8})">${g}</g>` : '',
          text(18, cy + 4.5, r.title, 13, { fill: isHot ? CLAY : INK, weight: isHot ? 600 : 400 }),
          body,
          text(IN_W - GEAR_W - 24, cy + 4.5, right, 12, { fill: MUTED, anchor: 'end' }),
          r.kind === 'run' ? '' : text(IN_W - GEAR_W - 8, cy + 4.5, '✕', 11, { fill: INK2, anchor: 'middle' }),
        ].join('')
      })
      .join('')
    parts.push(`<g opacity="${v.appear}">${rows}</g>`)
  }
  return `<rect x="${COL_X}" y="${top}" width="${COL_W}" height="${h}" rx="14" fill="${BAND}"/><g transform="translate(${COL_X + BAND_PAD_X} ${top + BAND_PAD_Y}) scale(${UI_S})">${parts.join('')}</g>`
}

// ---------- the window ----------
const BODY = 18
function conversation(t: number, which: Which): string {
  const y0 = WIN.y + TITLE_H + 40
  const bubble = (s: string, y: number) => {
    const w = textW(s, BODY) + 36
    return `<rect x="${COL_R - w}" y="${y}" width="${w}" height="${BODY + 26}" rx="16" fill="${BAND}"/>${text(COL_R - w + 18, y + BODY + 7, s, BODY)}`
  }
  const said = (s: string, y: number, o = 1) => (o > 0 && s ? `<g opacity="${o}">${text(COL_X, y + BODY, s, BODY)}</g>` : '')
  if (which === 'shop') return bubble('幫我重構訂單模組', y0) + said('好，先讀現有模組，再拆成步驟動手。', y0 + 76, ramp(t, T.uiIn + 0.5, T.uiIn + 0.8)) + said(replyAt(t), y0 + 122, ramp(t, T.replyFrom, T.replyFrom + 0.15))
  return bubble('跑第 5 批回測', y0) + said('好，資料先抓下來，接著跑回測。', y0 + 76)
}
function sessionHeader(which: Which): string {
  const s = SESSIONS[which]
  const cy = WIN.y + 33
  const x = MAIN_X + 22
  const tagX = x + textW(s.title, 17) + 22
  return text(x, cy + 6, s.title, 17, { weight: 500 }) + `<rect x="${tagX}" y="${cy - 13}" width="${textW(s.folder, 14) + 14}" height="26" rx="6" fill="#E4E4E4"/>` + text(tagX + 7, cy + 5, s.folder, 14, { fill: '#545451' })
}
function sidebar(t: number): string {
  const x = WIN.x
  const tx = x + 50
  const nav = ['新增', '成品', '例行工作', '自訂']
  const navItems = nav.map((s, i) => text(tx, WIN.y + 110 + i * 36, s, 16, { fill: SIDE_INK }) + `<rect x="${x + 22}" y="${WIN.y + 98 + i * 36}" width="14" height="14" rx="3.5" fill="none" stroke="${INK2}" stroke-width="1.5"/>`).join('')
  const groups: (keyof typeof SESSIONS)[] = ['shop', 'bot', 'api', 'notes']
  let y = WIN.y + 290
  const itemY: Record<string, number> = {}
  const list = groups
    .map(id => {
      const head = text(x + 20, y, SESSIONS[id].folder, 14, { fill: MUTED })
      y += 34
      itemY[id] = y
      const row = `<circle cx="${x + 30}" cy="${y - 5}" r="3.5" fill="none" stroke="${MUTED}" stroke-width="1.2"/>` + text(tx, y, SESSIONS[id].title, 16, { fill: SIDE_INK })
      y += 46
      return head + row
    })
    .join('')
  const hy = itemY.shop + (itemY.bot - itemY.shop) * easeInOut((t - T.botClick) / T.switchDur)
  return [
    `<rect x="${x}" y="${WIN.y}" width="${SIDE_W}" height="${WIN.h}" fill="${SIDE}"/>`,
    `<rect x="${x + SIDE_W - 1}" y="${WIN.y + TITLE_H}" width="1" height="${WIN.h - TITLE_H}" fill="${SIDE_LINE}"/>`,
    ['#FF5F57', '#FEBC2E', '#28C840'].map((c, i) => `<circle cx="${x + 30 + i * 26}" cy="${WIN.y + 33}" r="7.5" fill="${c}"/>`).join(''),
    navItems,
    `<rect x="${x + 10}" y="${hy - 24}" width="${SIDE_W - 20}" height="34" rx="8" fill="${SIDE_ON}"/>`,
    list,
  ].join('')
}
function appWindow(t: number, hot: string | null): string {
  const which = whichAt(t)
  const out = easeInOut((t - T.botClick) / (T.switchDur / 2))
  const inn = easeInOut((t - T.botClick - T.switchDur / 2) / (T.switchDur / 2))
  const main = (w: Which, at: number) => sessionHeader(w) + conversation(at, w) + band(at, w, w === 'shop' ? hot : null)
  const contents =
    which === 'shop'
      ? main('shop', t)
      : [
          out < 1 ? `<g opacity="${1 - out}" transform="translate(${-30 * out} 0)">${main('shop', T.botClick - 0.001)}</g>` : '',
          inn > 0 ? `<g opacity="${inn}" transform="translate(${30 * (1 - inn)} 0)">${main('bot', t)}</g>` : '',
        ].join('')
  const ty = INPUT_TOP + INPUT_H / 2 + 6
  const prompt = [
    `<rect x="${COL_X}" y="${INPUT_TOP}" width="${COL_W}" height="${INPUT_H}" rx="14" fill="#FFFFFF" stroke="${INPUT_LINE}" stroke-width="1.5"/>`,
    text(COL_X + 20, ty, '↵ 送出，⌘↵ 排到後面', BODY, { fill: PLACEHOLDER }),
    text(COL_X + 10, FOOT_Y, '略過權限確認', 15, { fill: FOOT_INK }),
    text(COL_R - 120, FOOT_Y, 'Opus 5.5', 15, { fill: INK, anchor: 'end' }),
    text(COL_R - 40, FOOT_Y, '高', 15, { fill: INK, anchor: 'end' }),
  ].join('')
  return [
    `<rect x="${WIN.x}" y="${WIN.y}" width="${WIN.w}" height="${WIN.h}" rx="18" fill="${MAIN_BG}"/>`,
    `<clipPath id="win"><rect x="${WIN.x}" y="${WIN.y}" width="${WIN.w}" height="${WIN.h}" rx="18"/></clipPath>`,
    `<g clip-path="url(#win)">`,
    sidebar(t),
    contents,
    prompt,
    `</g>`,
    `<rect x="${WIN.x}" y="${WIN.y}" width="${WIN.w}" height="${WIN.h}" rx="18" fill="none" stroke="#00000022" stroke-width="1.5"/>`,
  ].join('')
}

// ---------- the pane: progress, sounds, colours, then the style tiles ----------
const BTN_H = 24
const btnW = (label: string) => Math.max(38, textW(label, 12) + 24)
const button = (x: number, y: number, label: string, isOn: boolean) => {
  const w = btnW(label)
  return (isOn ? `<rect x="${x}" y="${y}" width="${w}" height="${BTN_H}" rx="6" fill="${INK}"/>` : `<rect x="${x}" y="${y}" width="${w}" height="${BTN_H}" rx="6" fill="${CARD}" stroke="${LINE}"/>`) + text(x + w / 2, y + 16, label, 12, { fill: isOn ? '#FFFBF7' : INK, anchor: 'middle', weight: 500 })
}
const ACCENTS = ['跟樣式預設', '陶土橘', '藍', '紫', '青', '桃紅', '墨黑']
const accentX = (i: number) => ACCENTS.slice(0, i).reduce((x, l) => x + btnW(l) + 6, 0)
const PANE_STYLES: [StyleKey, string][] = [
  ['segments', '分段'],
  ['hairline', '細線'],
  ['beads', '串珠'],
  ['ledger', '刻度字'],
  ['transit', '路線圖'],
  ['grid', '點陣'],
]
const P_W = 520 // UI units
const P_SCALE = 0.85
const P_X = MAIN_X + 40
const P_TOP = WIN.y + 18
const P_PAD = 18
const TILE_W = P_W - 24
const COLOR_Y = 70
const LIST_Y = 128
function paneLayout(now: number) {
  const prev = (id: StyleKey) => STYLES[id].draw(plan(`preview-${id}`, '重構訂單模組', stagesAt(SHOP, 5), 'running', 120_000, now) as never, TILE_W, now, null)
  const slotH = Math.max(...PANE_STYLES.map(([id]) => prev(id).height))
  const tileH = 10 + BTN_H + 8 + slotH + 10
  const tileY = (i: number) => LIST_Y + 12 + i * (tileH + 8)
  const useBtn = (i: number, isCur: boolean) => ({ x: P_W - 10 - btnW(isCur ? '✓ 使用中' : '使用'), y: tileY(i) + 10 })
  return { prev, slotH, tileH, tileY, useBtn }
}
const paneH = () => INPUT_TOP - 30 - P_TOP
const inPane = (u: Pt): Pt => ({ x: P_X + (P_PAD + u.x) * P_SCALE, y: P_TOP + (P_PAD + u.y) * P_SCALE })
function pane(t: number): string {
  const now = NOW0 + t * 1000
  setAccent(accentAt(t))
  const L = paneLayout(now)
  const style = styleAt(t)
  const accent = accentAt(t)
  const drawn = lastOf(t, [T.paneIn, T.beadsClick, T.tealClick])
  const tiles = PANE_STYLES.map(([id, name], i) => {
    const ty = L.tileY(i)
    const isCur = id === style
    const b = L.useBtn(i, isCur)
    const d = L.prev(id)
    return [
      `<rect x="0" y="${ty}" width="${P_W}" height="${L.tileH}" rx="10" fill="${CARD}" stroke="${isCur ? INK : LINE}" stroke-width="${isCur ? 1.5 : 1}"/>`,
      text(12, ty + 27, name, 13, { weight: 600 }),
      text(12 + textW(name, 13) + 8, ty + 27, id, 11, { fill: MUTED }),
      button(b.x, b.y, isCur ? '✓ 使用中' : '使用', isCur),
      `<g transform="translate(12 ${ty + 10 + BTN_H + 8 + (L.slotH - d.height) / 2})">${drawnAt(drawn, d.svg)}</g>`,
    ].join('')
  }).join('')
  const ui = [
    text(0, 14, '進度條', 13, { weight: 600 }),
    button(0, 22, '顯示', true),
    button(btnW('顯示') + 6, 22, '隱藏', false),
    text(140, 14, '提示音', 13, { weight: 600 }),
    button(140, 22, '開', true),
    button(140 + btnW('開') + 6, 22, '關', false),
    button(P_W - btnW('儲存並關閉'), 22, '儲存並關閉', true),
    text(0, COLOR_Y, '顏色', 13, { weight: 600 }),
    ...ACCENTS.map((l, i) => button(accentX(i), COLOR_Y + 8, l, accent ? i === 4 : i === 0)),
    text(0, LIST_Y + 4, '進度條樣式', 13, { weight: 600 }),
    tiles,
  ].join('')
  const h = paneH()
  return `<clipPath id="pane"><rect x="${P_X}" y="${P_TOP}" width="${(P_W + 2 * P_PAD) * P_SCALE}" height="${h}" rx="18"/></clipPath>
<rect x="${P_X}" y="${P_TOP}" width="${(P_W + 2 * P_PAD) * P_SCALE}" height="${h}" rx="18" fill="${CARD}" stroke="${INK}" stroke-opacity=".18" stroke-width="2"/>
<g clip-path="url(#pane)"><g transform="translate(${P_X + P_PAD * P_SCALE} ${P_TOP + P_PAD * P_SCALE}) scale(${P_SCALE})">${ui}</g></g>`
}

// ---------- camera: one cue at a time, a slow push in on what the caption talks about ----------
type Cam = { s: number; cx: number; cy: number }
const WIDE: Cam = { s: 1, cx: W / 2, cy: H / 2 + 20 }
// where the camera rests, at key times; between two keys it eases from one to the next, and holds after the last
const bandCam = (w: Which, at: number, s: number, lift = 40): Cam => ({ s, cx: COL_X + COL_W / 2, cy: bandTopOf(at, w) + bandHOf(at, w) / 2 - lift })
const replyCam = (): Cam => ({ s: 1.3, cx: COL_X + COL_W / 2, cy: 624 })
// the pane centred, its top just under the caption
const paneCam = (): Cam => ({ s: 1.25, cx: P_X + ((P_W + 2 * P_PAD) * P_SCALE) / 2, cy: P_TOP + 320 })
function camKeys(t: number): [number, Cam][] {
  return [
    [0, WIDE],
    [T.zoomIn[0], WIDE],
    [T.zoomIn[1], bandCam('shop', t, 1.6)],
    [T.stepLast - 0.2, bandCam('shop', t, 1.6)],
    [T.replyFrom + 0.6, replyCam()],
    [T.zoomOut[0], replyCam()],
    [T.zoomOut[1], WIDE],
    [T.crossZoom[0], WIDE],
    [T.crossZoom[1], bandCam('shop', t, 1.32, 0)],
    [T.crossZoomOut[0], bandCam(whichAt(t), t, 1.32, 0)],
    [T.crossZoomOut[1], WIDE],
    [T.gearClick + 0.2, WIDE],
    [T.paneIn + 0.8, paneCam()],
    [T.closeClick, paneCam()],
    [T.closeClick + 0.8, WIDE],
    [T.skipZoom[0], WIDE],
    [T.skipZoom[1], bandCam('bot', t, 1.6, 0)],
    [T.skipZoomOut[0], bandCam('bot', t, 1.6, 0)],
    [T.skipZoomOut[1], WIDE],
  ]
}
function camAt(t: number): Cam {
  const keys = camKeys(t)
  const mix = (a: Cam, b: Cam, e: number): Cam => ({ s: lerp(a.s, b.s, e), cx: lerp(a.cx, b.cx, e), cy: lerp(a.cy, b.cy, e) })
  for (let i = keys.length - 1; i >= 0; i--) {
    const [at, cam] = keys[i]
    if (t >= at) {
      const next = keys[i + 1]
      return next ? mix(cam, next[1], easeInOut((t - at) / (next[0] - at))) : cam
    }
  }
  return WIDE
}
const camTransform = (c: Cam) => `translate(${W / 2} ${H / 2 + 20}) scale(${c.s}) translate(${-c.cx} ${-c.cy})`
const toScreen = (c: Cam, p: Pt): Pt => ({ x: W / 2 + (p.x - c.cx) * c.s, y: H / 2 + 20 + (p.y - c.cy) * c.s })

// ---------- cursor ----------
function cursor(t: number): string {
  const home = { x: 1500, y: 980 }
  const bot = toScreen(camAt(T.botClick), rowPt(T.botClick - 0.001, 'shop', 'bot'))
  const gear = toScreen(camAt(T.gearClick), gearPt(T.gearClick, 'bot'))
  const L = paneLayout(NOW0)
  const beadsB = L.useBtn(2, false)
  const beads = toScreen(camAt(T.beadsClick), inPane({ x: beadsB.x + btnW('使用') / 2, y: beadsB.y + 12 }))
  const teal = toScreen(camAt(T.tealClick), inPane({ x: accentX(4) + btnW('青') / 2, y: COLOR_Y + 8 + 12 }))
  const close = toScreen(camAt(T.closeClick), inPane({ x: P_W - btnW('儲存並關閉') / 2, y: 22 + 12 }))
  const legs: [number[], Pt, Pt][] = [
    [T.botMove, home, bot],
    [T.gearMove, bot, gear],
    [T.beadsMove, gear, beads],
    [T.tealMove, beads, teal],
    [T.closeMove, teal, close],
  ]
  let at = home
  for (const [[a, b], from, to] of legs) if (t >= a) at = { x: lerp(from.x, to.x, easeInOut((t - a) / (b - a))), y: lerp(from.y, to.y, easeInOut((t - a) / (b - a))) }
  const opacity = fade(t, T.botMove[0] - 0.3, T.botMove[0], T.cursorOut[0], T.cursorOut[1])
  if (opacity <= 0) return ''
  const ring = CLICKS.map(c => {
    const k = (t - c) / 0.45
    if (k < 0 || k > 1) return ''
    return `<circle cx="${at.x}" cy="${at.y}" r="${12 + 28 * easeOut(k)}" fill="none" stroke="${CLAY}" stroke-width="3" opacity="${(1 - k) * 0.7}"/>`
  }).join('')
  const press = CLICKS.some(c => t >= c && t < c + 0.12) ? 0.88 : 1
  return `<g opacity="${opacity}">${ring}<g transform="translate(${at.x} ${at.y}) scale(${1.5 * press})"><path d="M0 0 L0 21 L5.5 15.5 L9.5 24.5 L13 23 L9 14 L16.5 14 Z" fill="${INK}" stroke="#FFFFFF" stroke-width="1.6" stroke-linejoin="round"/></g></g>`
}

// the done sound, seen: a small speaker with waves beside the bar while it plays
function soundCue(t: number): string {
  const k = (t - T.allDone) / 1.2
  if (k < 0 || k > 1) return ''
  const c = camAt(t)
  const p = toScreen(c, { x: COL_R - 40, y: bandTopOf(t, 'shop') - 30 })
  const o = Math.sin(Math.PI * k)
  return `<g opacity="${o}" transform="translate(${p.x} ${p.y})"><rect x="-62" y="-26" width="142" height="52" rx="26" fill="${INK}"/><path d="M-30 -7 h8 l10 -9 v32 l-10 -9 h-8 z" fill="#FFFBF7"/><path d="M-4 -9 q8 9 0 18 M3 -15 q14 15 0 30" fill="none" stroke="#FFFBF7" stroke-width="3" stroke-linecap="round"/>${text(42, 7, 'Done', 18, { fill: '#FFFBF7', weight: 600, anchor: 'middle' })}</g>`
}

// ---------- cards ----------
function hookCard(t: number): string {
  const o = fade(t, T.hookIn, T.hookIn + 0.5, T.hookOut - 0.4, T.hookOut)
  if (o <= 0) return ''
  // a spinner line with nothing else: what a long task looks like without the plugin
  const dots = [0, 1, 2].map(i => `<circle cx="${W / 2 - 150 + i * 16}" cy="${H / 2 + 90}" r="5" fill="${CLAY}" opacity="${0.35 + 0.65 * ((Math.sin(t * 6 - i) + 1) / 2)}"/>`).join('')
  return `<g opacity="${o}">${text(W / 2, H / 2 - 30, 'Claude 正在做事。', 64, { weight: 700, anchor: 'middle' })}${text(W / 2, H / 2 + 40, '但做到哪了？還要多久？', 44, { fill: MUTED, anchor: 'middle' })}${dots}${text(W / 2 - 104, H / 2 + 98, 'Working…', 22, { fill: MUTED })}</g>`
}
function titleCard(t: number): string {
  const o = fade(t, T.titleIn, T.titleIn + 0.5, T.titleOut - 0.4, T.titleOut)
  if (o <= 0) return ''
  const dy = (1 - ramp(t, T.titleIn, T.titleIn + 0.7)) * 20
  return `<g opacity="${o}" transform="translate(0 ${dy})"><circle cx="${W / 2}" cy="${H / 2 - 120}" r="14" fill="${CLAY}"/>${text(W / 2, H / 2 + 10, 'plan-progress', 112, { weight: 700, anchor: 'middle' })}${text(W / 2, H / 2 + 80, '給 Claude Code 的即時進度條', 40, { fill: MUTED, anchor: 'middle' })}</g>`
}
function endCard(t: number): string {
  const o = ramp(t, T.endIn, T.endIn + 0.6)
  if (o <= 0) return ''
  // the two commands the README gives, in a monospace box sized to the longer one
  const cmds = ['claude plugin marketplace add 0x5421/plan-progress', 'claude plugin install plan-progress@fork-zycck-mods']
  const cw = Math.max(...cmds.map(c => c.length)) * 24 * 0.61 + 72
  const box = `<rect x="${W / 2 - cw / 2}" y="${H / 2 + 20}" width="${cw}" height="104" rx="14" fill="${INK}"/>` + cmds.map((c, i) => text(W / 2 - cw / 2 + 36, H / 2 + 62 + i * 40, c, 24, { fill: '#FFFBF7', font: MONO })).join('')
  return `<g opacity="${o}"><circle cx="${W / 2}" cy="${H / 2 - 210}" r="14" fill="${CLAY}"/>${text(W / 2, H / 2 - 100, 'plan-progress', 104, { weight: 700, anchor: 'middle' })}${text(W / 2, H / 2 - 40, '看得見的進度，從下一個任務開始', 36, { fill: MUTED, anchor: 'middle' })}${box}${text(W / 2, H / 2 + 190, 'github.com/0x5421/plan-progress', 28, { fill: INK2, anchor: 'middle' })}</g>`
}
function frame(t: number): string {
  drawingN = 0
  const uiO = fade(t, T.uiIn, T.uiIn + 0.5, T.uiOut, T.uiOut + 0.5)
  const paneO = fade(t, T.paneIn, T.paneIn + 0.3, T.paneOut, T.paneOut + 0.3)
  const paneDy = (1 - ramp(t, T.paneIn, T.paneIn + 0.3)) * 20 + ramp(t, T.paneOut, T.paneOut + 0.3) * 20
  const hot = t > T.botClick - 0.25 && t < T.botClick + 0.4 ? 'bot' : null
  const [cap, sub, capO] = captionAt(t)
  const parts = [`<rect width="${W}" height="${H}" fill="${BG}"/>`, hookCard(t), titleCard(t)]
  if (uiO > 0) {
    const cam = camAt(t)
    parts.push(`<g opacity="${uiO}"><g transform="${camTransform(cam)}">${appWindow(t, hot)}${paneO > 0 ? `<g opacity="${paneO}" transform="translate(0 ${paneDy})">${pane(t)}</g>` : ''}</g>`)
    // the caption sits on a soft band at the top, over the window when the camera is in close
    parts.push(`<g opacity="${capO}"><rect x="0" y="0" width="${W}" height="150" fill="${BG}"/>${text(W / 2, 74, cap, 50, { weight: 700, anchor: 'middle' })}${text(W / 2, 122, sub, 26, { fill: MUTED, anchor: 'middle' })}</g>`)
    parts.push(soundCue(t), `</g>`)
  }
  parts.push(cursor(t), endCard(t))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`
}

// ---------- headless Chrome over the DevTools protocol ----------
async function capture(): Promise<void> {
  rmSync(FRAMES, { recursive: true, force: true })
  mkdirSync(FRAMES, { recursive: true })
  const port = 9334
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${OUT_DIR}/chrome-profile`, '--hide-scrollbars', '--force-color-profile=srgb', 'about:blank'], { stdio: 'ignore' })
  try {
    let targets: { type: string; webSocketDebuggerUrl: string }[] = []
    for (let i = 0; i < 50 && !targets.length; i++) {
      try {
        targets = ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as typeof targets).filter(x => x.type === 'page')
      } catch {
        await new Promise(r => setTimeout(r, 200))
      }
    }
    if (!targets[0]) throw new Error('Chrome did not start')
    const ws = new WebSocket(targets[0].webSocketDebuggerUrl)
    await new Promise(r => ws.addEventListener('open', r, { once: true }))
    let id = 0
    const pending = new Map<number, (v: any) => void>()
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(String(ev.data))
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)!(msg.result ?? msg)
        pending.delete(msg.id)
      }
    })
    const send = (method: string, params: object = {}) => new Promise<any>(r => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })) })
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
    await send('Page.navigate', { url: 'data:text/html,<html><body style="margin:0;background:%23F5F4ED"></body></html>' })
    await new Promise(r => setTimeout(r, 500))
    const times = STILLS ?? Array.from({ length: DURATION * FPS }, (_, f) => f / FPS)
    for (const [f, t] of times.entries()) {
      const svg = frame(t)
      const ran = await send('Runtime.evaluate', {
        expression: `(() => { document.body.innerHTML = ${JSON.stringify(svg)}; const all = [...document.querySelectorAll('svg')]; const tick = () => new Promise(r => requestAnimationFrame(() => r())); return tick().then(tick).then(() => { for (const s of all) { const at = s.closest('[data-start]'); s.pauseAnimations(); s.setCurrentTime(Math.max(0, ${t} - (at ? Number(at.dataset.start) : 0))) } return tick().then(tick) }).then(() => all.length) })()`,
        awaitPromise: true,
        returnByValue: true,
      })
      if (ran.exceptionDetails) throw new Error(`frame ${f}: ${JSON.stringify(ran.exceptionDetails).slice(0, 400)}`)
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(`${FRAMES}/${STILLS ? `t${t.toFixed(2)}` : `f${String(f).padStart(4, '0')}`}.png`, Buffer.from(shot.data, 'base64'))
      if (f % 120 === 0) console.log(`frame ${f}/${times.length}`)
    }
    ws.close()
  } finally {
    chrome.kill()
  }
}

// ---------- soundtrack: no music, the clicks and the plugin's done sound where the plugin plays it ----------
const SR = 44100
function soundtrack(): Float32Array[] {
  const n = Math.ceil(DURATION * SR)
  const L = new Float32Array(n)
  const R = new Float32Array(n)
  const add = (at: number, mono: Float32Array, gain: number) => {
    const o = Math.round(at * SR)
    for (let i = 0; i < mono.length && o + i < n; i++) if (o + i >= 0) (L[o + i] += mono[i] * gain), (R[o + i] += mono[i] * gain)
  }
  let seed = 7
  const noise = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1
  const env = (t: number, a: number, d: number) => (t < a ? t / a : Math.exp(-(t - a) / d))
  const make = (sec: number, f: (t: number) => number) => Float32Array.from({ length: Math.round(sec * SR) }, (_, i) => f(i / SR))
  const highpass = (x: Float32Array, cutoff: number) => {
    const k = 1 - Math.exp((-2 * Math.PI * cutoff) / SR)
    let y = 0
    return x.map(v => v - (y += k * (v - y)))
  }
  const readWav = (name: string) => {
    const buf = readFileSync(new URL(`../plugins/plan-progress/sounds/${name}.wav`, import.meta.url))
    const at = buf.indexOf('data') + 8
    return Float32Array.from({ length: (buf.length - at) >> 1 }, (_, i) => buf.readInt16LE(at + i * 2) / 32768)
  }
  const click = () => highpass(make(0.04, t => (noise() * 0.6 + Math.sin(2 * Math.PI * 2400 * t)) * env(t, 0.0005, 0.006)), 900)
  for (const c of CLICKS) add(c, click(), 0.45)
  add(T.allDone, readWav('done'), 1)
  const peak = [L, R].reduce((m, ch) => ch.reduce((mm, v) => Math.max(mm, Math.abs(v)), m), 0)
  if (peak > 0.89) for (let i = 0; i < n; i++) (L[i] *= 0.89 / peak), (R[i] *= 0.89 / peak)
  return [L, R]
}
function writeWav(path: string, [L, R]: Float32Array[]) {
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
    buf.writeInt16LE(Math.round(clamp(R[i], -1, 1) * 32767), 46 + i * 4)
  }
  writeFileSync(path, buf)
}

const probe = args.find(a => a.startsWith('--probe='))
if (probe) {
  const t = Number(probe.slice('--probe='.length))
  const w = whichAt(t)
  console.log(JSON.stringify({ t, cam: camAt(t), bandTop: bandTopOf(t, w), bandH: bandHOf(t, w), inputTop: INPUT_TOP }))
  process.exit(0)
}
mkdirSync(OUT_DIR, { recursive: true })
await capture()
if (STILLS) {
  console.log(`stills: ${FRAMES}`)
} else {
  const audio = `${OUT_DIR}/soundtrack.wav`
  writeWav(audio, soundtrack())
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', `${FRAMES}/f%04d.png`, '-i', audio, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', '-preset', 'slow', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', `${OUT_DIR}/plan-progress-promo-v2.mp4`], { stdio: 'inherit' })
  console.log(`done: ${OUT_DIR}/plan-progress-promo-v2.mp4`)
}
