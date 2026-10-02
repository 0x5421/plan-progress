// Renders the vertical promo clip (1080x1920, 30 fps) frame by frame with the plugin's own drawing code,
// captures each frame in headless Chrome over the DevTools protocol, then joins them with ffmpeg.
// Run: node --experimental-strip-types promo/make-video.mts [outDir]
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { STYLES } from '../plugins/plan-progress/hooks/styles.ts'

type StyleKey = 'segments' | 'beads' | 'transit'
const OUT_DIR = process.argv[2] ?? new URL('./out', import.meta.url).pathname
const FRAMES = `${OUT_DIR}/frames`
const W = 1080
const H = 1920
const FPS = 30
const DURATION = 14
const S = 2 // UI drawn at 2x so it reads on a phone

// ---------- palette and type ----------
const BG = '#F5F3EE'
const CARD = '#FFFFFF'
const INK = '#1F1E1C'
const MUTED = '#86857F'
const LINE = '#E4E1D8'
const CLAY = '#C6613F'
const FONT = "-apple-system,BlinkMacSystemFont,'PingFang TC','Helvetica Neue',sans-serif"

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v))
const easeOut = (x: number) => 1 - Math.pow(1 - clamp(x), 3)
const ramp = (t: number, a: number, b: number) => easeOut((t - a) / (b - a))
const fade = (t: number, inA: number, inB: number, outA = Infinity, outB = Infinity) => Math.min(ramp(t, inA, inB), 1 - ramp(t, outA, outB))
const text = (x: number, y: number, s: string, size: number, o: { fill?: string; weight?: number; anchor?: string; opacity?: number } = {}) =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${o.weight ?? 400}" fill="${o.fill ?? INK}" text-anchor="${o.anchor ?? 'start'}" opacity="${o.opacity ?? 1}">${esc(s)}</text>`

// ---------- the demo plan ----------
const STAGES: [string, string[]][] = [
  ['Analysis', ['讀現有模組', '找相依關係', '列出改動']],
  ['Build', ['資料表結構', '寫遷移', '搬資料', '建索引']],
  ['Test', ['單元測試', '整合測試']],
  ['Ship', ['打包', '發佈']],
]
function plan(k: number, now: number) {
  let i = 0
  return {
    id: 'promo',
    title: '重構訂單模組',
    kind: 'plan' as const,
    state: 'running' as const,
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
// a drawing placed centred in a fixed-height slot, as the pane does
const slot = (d: { svg: string; height: number }, w: number, h: number) =>
  `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" overflow="visible"><g transform="translate(0 ${(h - d.height) / 2})">${d.svg}</g></svg>`

// ---------- timeline ----------
const T = { titleOut: 1.5, uiIn: 1.7, gearMove: [5.6, 6.4], gearClick: 6.5, panelIn: 6.6, beadsMove: [7.2, 7.9], beadsClick: 8.0, transitMove: [8.9, 9.6], transitClick: 9.7, uiOut: 11.6, endIn: 11.9 }
const stepAt = (t: number) => Math.min(9, 3 + Math.floor(Math.max(0, t - 2.2) / 0.85))
const styleAt = (t: number): StyleKey => (t < T.beadsClick ? 'segments' : t < T.transitClick ? 'beads' : 'transit')
const captionAt = (t: number): [string, number] => {
  if (t < 5.4) return ['Claude 做事時，進度一目了然', fade(t, 2.0, 2.4, 5.2, 5.4)]
  if (t < 7.0) return ['點 ⚙ 打開設定面板', fade(t, 5.4, 5.7, 6.8, 7.0)]
  return ['六種風格，點一下就換', fade(t, 7.0, 7.3, T.uiOut, T.uiOut + 0.3)]
}

// ---------- layout (px) ----------
const CARD_X = 60
const CARD_Y = 700
const PAD = 16 * S
const IN_X = CARD_X + PAD
const IN_Y = CARD_Y + PAD
const IN_W = 448 // UI units
const BAR_X = 100
const BAR_W = 300
const PANEL_Y = 1060
const P_IN_Y = PANEL_Y + PAD
const TILE_Y0 = 28
const TILE_H = 72
const TILE_GAP = 10
const TILES: StyleKey[] = ['segments', 'beads', 'transit']
const TILE_NAME: Record<StyleKey, string> = { segments: '分段', beads: '串珠', transit: '路線圖' }
const px = (ux: number) => IN_X + ux * S
const py = (uy: number) => IN_Y + uy * S
const ppy = (uy: number) => P_IN_Y + uy * S
const GEAR = { x: px(384), y: py(113) }
const buttonWidth = (current: boolean) => (current ? 66 : 40)
// the cursor lands near a button's right edge, so after the click its label stays readable
const tileButton = (i: number) => ({ x: px(IN_W - 12 - 7), y: ppy(TILE_Y0 + i * (TILE_H + TILE_GAP) + 19) })

// ---------- scene pieces ----------
function windowCard(t: number, style: StyleKey, gearHot: boolean): string {
  const now = 1_790_000_000_000 + t * 1000
  const p = plan(stepAt(t), now)
  const look = STYLES[style]
  const bar = slot(look.draw(p as never, BAR_W, now, null), BAR_W, 36)
  const glyph = look.glyph(p as never)
  const ui = [
    glyph ? text(0, 23, glyph.char, 12, { fill: glyph.color }) : '',
    text(14, 23, p.title, 13, { weight: 500 }),
    `<g transform="translate(${BAR_X} 0)">${bar}</g>`,
    text(IN_W, 23, look.right(p as never, now), 12, { fill: MUTED, anchor: 'end' }),
    `<rect x="0" y="48" width="${IN_W}" height="44" rx="12" fill="${CARD}" stroke="${LINE}"/>`,
    text(14, 75, '請 Claude 幫你…', 13, { fill: MUTED }),
    text(374, 117, 'Progress', 11.5, { fill: MUTED, anchor: 'end' }),
    text(384, 118.5, '⚙︎', 15, { fill: gearHot ? CLAY : INK, anchor: 'middle' }),
    text(IN_W, 117, 'Opus 5.5', 11.5, { fill: MUTED, anchor: 'end' }),
  ].join('')
  return `<rect x="${CARD_X}" y="${CARD_Y}" width="${W - 2 * CARD_X}" height="${150 * S}" rx="28" fill="${CARD}" stroke="${LINE}" stroke-width="2"/>
<g transform="translate(${IN_X} ${IN_Y}) scale(${S})">${ui}</g>`
}

function panelCard(t: number, style: StyleKey): string {
  const now = 1_790_000_000_000 + t * 1000
  const demo = plan(5, now)
  const tiles = TILES.map((id, i) => {
    const ty = TILE_Y0 + i * (TILE_H + TILE_GAP)
    const current = id === style
    const bw = buttonWidth(current)
    const bx = IN_W - 12 - bw
    const preview = slot(STYLES[id].draw(demo as never, 420, now, null), 420, 36)
    return [
      `<rect x="0" y="${ty}" width="${IN_W}" height="${TILE_H}" rx="10" fill="${CARD}" stroke="${current ? CLAY : LINE}" stroke-width="${current ? 1.5 : 1}"/>`,
      text(12, ty + 23, TILE_NAME[id], 13, { weight: 600, fill: current ? CLAY : INK }),
      text(12 + TILE_NAME[id].length * 13 + 8, ty + 23, id, 11, { fill: MUTED }),
      current
        ? `<rect x="${bx}" y="${ty + 9}" width="${bw}" height="21" rx="6" fill="${CLAY}"/>` + text(bx + bw / 2, ty + 23.5, '✓ 使用中', 11, { fill: '#FFFBF7', anchor: 'middle', weight: 500 })
        : `<rect x="${bx}" y="${ty + 9}" width="${bw}" height="21" rx="6" fill="${CARD}" stroke="${LINE}"/>` + text(bx + bw / 2, ty + 23.5, '使用', 11, { anchor: 'middle' }),
      `<g transform="translate(14 ${ty + 34})">${preview}</g>`,
    ].join('')
  })
  const ui = text(0, 15, '進度條樣式', 14, { weight: 600 }) + tiles.join('')
  return `<rect x="${CARD_X}" y="${PANEL_Y}" width="${W - 2 * CARD_X}" height="${296 * S}" rx="28" fill="${CARD}" stroke="${LINE}" stroke-width="2"/>
<g transform="translate(${IN_X} ${P_IN_Y}) scale(${S})">${ui}</g>`
}

function cursor(t: number): string {
  const home = { x: 940, y: 1560 }
  const gear = GEAR
  const beads = tileButton(1)
  const transit = tileButton(2)
  const lerp = (a: { x: number; y: number }, b: { x: number; y: number }, e: number) => ({ x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e })
  let at = home
  if (t >= T.gearMove[0]) at = lerp(home, gear, ramp(t, T.gearMove[0], T.gearMove[1]))
  if (t >= T.beadsMove[0]) at = lerp(gear, beads, ramp(t, T.beadsMove[0], T.beadsMove[1]))
  if (t >= T.transitMove[0]) at = lerp(beads, transit, ramp(t, T.transitMove[0], T.transitMove[1]))
  const opacity = fade(t, 5.4, 5.6, 11.0, 11.4)
  if (opacity <= 0) return ''
  const ring = [T.gearClick, T.beadsClick, T.transitClick]
    .map(c => {
      const k = (t - c) / 0.4
      if (k < 0 || k > 1) return ''
      return `<circle cx="${at.x}" cy="${at.y}" r="${14 + 30 * easeOut(k)}" fill="none" stroke="${CLAY}" stroke-width="3" opacity="${(1 - k) * 0.7}"/>`
    })
    .join('')
  const press = [T.gearClick, T.beadsClick, T.transitClick].some(c => t >= c && t < c + 0.12) ? 0.88 : 1
  return `<g opacity="${opacity}">${ring}<g transform="translate(${at.x} ${at.y}) scale(${1.7 * press})"><path d="M0 0 L0 21 L5.5 15.5 L9.5 24.5 L13 23 L9 14 L16.5 14 Z" fill="${INK}" stroke="#FFFFFF" stroke-width="1.6" stroke-linejoin="round"/></g></g>`
}

function frame(t: number): string {
  const style = styleAt(t)
  const titleO = 1 - ramp(t, T.titleOut, T.titleOut + 0.4)
  const uiO = fade(t, T.uiIn, T.uiIn + 0.4, T.uiOut, T.uiOut + 0.4)
  const panelO = fade(t, T.panelIn, T.panelIn + 0.35, T.uiOut, T.uiOut + 0.4)
  const panelDy = (1 - ramp(t, T.panelIn, T.panelIn + 0.35)) * 24
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
    parts.push(`<g opacity="${uiO}">`, text(W / 2, 540, caption, 50, { weight: 700, anchor: 'middle', opacity: capO }), windowCard(t, style, gearHot), `</g>`)
    if (panelO > 0) parts.push(`<g opacity="${panelO}" transform="translate(0 ${panelDy})">`, panelCard(t, style), `</g>`)
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
    const total = DURATION * FPS
    for (let f = 0; f < total; f++) {
      const t = f / FPS
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
      writeFileSync(`${FRAMES}/f${String(f).padStart(4, '0')}.png`, Buffer.from(shot.data, 'base64'))
      if (f % 60 === 0) console.log(`frame ${f}/${total}`)
    }
    ws.close()
  } finally {
    chrome.kill()
  }
}

await capture()
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', `${FRAMES}/f%04d.png`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', '-preset', 'slow', '-movflags', '+faststart', `${OUT_DIR}/plan-progress-promo.mp4`], { stdio: 'inherit' })
console.log(`done: ${OUT_DIR}/plan-progress-promo.mp4`)
