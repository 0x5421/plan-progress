import type { AgentRun, Plan, PlanState, StepStatus } from '../types'

// the bar styles a person can switch between with /progress-style; 'original' is the author's pixel bar in register.tsx
export const STYLE_IDS = ['segments', 'hairline', 'beads', 'ledger', 'transit', 'grid', 'original'] as const
export type StyleId = (typeof STYLE_IDS)[number]
export const DEFAULT_STYLE: StyleId = 'segments'
export const STYLE_INFO: Record<StyleId, string> = {
  segments: '分段：一個階段一格，現在這段最顯眼、做完的變淡（陶土橘）',
  hairline: '細線：2px 細線＋會呼吸的線頭，平常黑白，右邊顯示經過時間',
  beads: '串珠：一步一顆珠子，同階段用線串起來（藍）',
  ledger: '刻度字：等寬字＋小方格，像終端機游標，只有要注意時才有顏色',
  transit: '路線圖：像捷運圖，站名在下方，比其他版本高一點（紫）',
  grid: '點陣：一步一個小方格，階段之間空一格，步驟多也排得下（青）',
  original: '原版：作者的像素顆粒進度條',
}
export const isStyleId = (v: unknown): v is StyleId => typeof v === 'string' && (STYLE_IDS as readonly string[]).includes(v)

export type Visible = { shown: AgentRun[]; hidden: AgentRun[] }
export type Drawn = { svg: string; height: number }
export type Glyph = { char: string; color: string } | null
export type BarStyle = {
  glyph: (p: Plan) => Glyph
  right: (p: Plan, now: number) => string
  draw: (p: Plan, W: number, now: number, agents: Visible | null) => Drawn
}

// colours live in CSS variables so one drawing follows the app's light or dark scheme
const PALETTE = `<style>svg{--ink:#1F1E1C;--muted:#73726C;--track:rgba(31,30,28,.08);--faint:rgba(31,30,28,.24);--panel:#F0EEE6;--on:#FFFBF7;--amber:#B26F12;--red:#C93C3C;--green:#2E8655;--clay:#C6613F;--blue:#3D6FD6;--violet:#6B5BD2;--clayS:#A9502F;--greenS:#256F46;--teal:#0E8A8F}
@media (prefers-color-scheme:dark){svg{--ink:#F2F0EA;--muted:#A3A19A;--track:rgba(242,240,234,.10);--faint:rgba(242,240,234,.30);--panel:#2A2927;--on:#1F1E1C;--amber:#E2A64B;--red:#F07272;--green:#5FC58D;--clay:#E08A6A;--blue:#86A8F2;--violet:#A99CF6;--clayS:#E08A6A;--greenS:#5FC58D;--teal:#4FC3C7}}</style>`
// the glyph left of the title is a Text colour, one hex for both schemes
const GLYPH_COLOR = { clay: '#D97757', blue: '#5B85E8', violet: '#8B7CF6', teal: '#14A3A8', needs_input: '#E09A1E', error: '#E5484D', done: '#30A46C' }
const SANS = "'Anthropic Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif"
const MONO = "ui-monospace,'SF Mono',Menlo,monospace"

const svg = (W: number, H: number, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${PALETTE}${body}</svg>`
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
const fin = (s: StepStatus) => s === 'done' || s === 'skipped'
const n1 = (v: number) => v.toFixed(1)
const fill = (c: string, op?: number) => `style="fill:${c}${op === undefined ? '' : `;fill-opacity:${op}`}"`
const ring = (c: string, w: number, bg = 'var(--panel)') => `style="fill:${bg};stroke:${c};stroke-width:${w}"`

// an estimate of drawn text width; the module has no canvas to measure with
function textWidth(s: string, px: number, mono = false): number {
  return [...s].reduce((w, ch) => {
    if (/[　-鿿＀-￯]/.test(ch)) return w + px
    if (mono) return w + px * 0.6
    if (/[ilI.,:;'|!]/.test(ch)) return w + px * 0.3
    if (/[mwMW]/.test(ch)) return w + px * 0.82
    if (/[A-Z]/.test(ch)) return w + px * 0.66
    return w + px * 0.55
  }, 0)
}
function fit(s: string, px: number, max: number, mono = false): string {
  if (textWidth(s, px, mono) <= max) return s
  let t = s
  while (t.length > 1 && textWidth(t + '…', px, mono) > max) t = t.slice(0, -1)
  return t.length > 1 ? t + '…' : ''
}

type Where = { pos: number; total: number; stage: number; step: number; stageSize: number; title: string }
function where(p: Plan): Where {
  const steps = p.stages.flatMap((s, i) => s.steps.map((step, j) => ({ i, j, step })))
  const at = steps.findIndex(x => !fin(x.step.status))
  const pos = p.state === 'done' || at < 0 ? steps.length : at
  const cur = steps[Math.min(pos, steps.length - 1)]
  const stage = cur?.i ?? 0
  const stageSize = p.stages[stage]?.steps.length ?? 0
  return { pos, total: steps.length, stage, step: pos >= steps.length ? stageSize : (cur?.j ?? 0) + 1, stageSize, title: cur?.step.title ?? '' }
}
const stateVar = (state: PlanState, accent: string) =>
  state === 'running' ? accent : state === 'needs_input' ? 'var(--amber)' : state === 'error' ? 'var(--red)' : 'var(--green)'
const glyphFor = (p: Plan, accent: string): Glyph => ({
  char: p.state === 'needs_input' ? '?' : p.state === 'error' ? '!' : p.state === 'done' ? '✓' : '●',
  color: p.state === 'running' ? accent : GLYPH_COLOR[p.state],
})
const percent = (p: Plan) => {
  const w = where(p)
  return `${p.state === 'done' ? 100 : Math.round((Math.min(w.pos, w.total) / Math.max(1, w.total)) * 100)}%`
}
const stepCount = (p: Plan) => {
  const w = where(p)
  return `${Math.min(w.pos, w.total)}/${w.total}`
}
const elapsed = (ms: number) => {
  const sec = Math.max(0, Math.round(ms / 1000))
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`
}

// ---------- agent strips, shared by the new styles ----------

type StripLook = { accent: string; bg: boolean; mono?: boolean; tint?: number }
function strips(v: Visible, W: number, now: number, o: StripLook): { body: string; height: number } {
  const RH = o.bg ? 18 : 16
  const GAP = o.bg ? 3 : 2
  const px = o.mono ? 10.5 : 11.5
  const family = o.mono ? MONO : SANS
  const colour = (a: AgentRun) => (a.state === 'running' ? o.accent : a.state === 'waiting' ? 'var(--amber)' : a.state === 'done' ? 'var(--green)' : 'var(--red)')
  const rows: string[] = []
  v.shown.forEach((a, i) => {
    const y = i * (RH + GAP)
    const cy = y + RH / 2
    const c = colour(a)
    const indent = a.depth > 0 ? 12 : 0
    let row = o.bg ? `<rect x="0" y="${y}" width="${W}" height="${RH}" rx="${RH / 2}" ${fill(c, o.tint ?? 0.12)}/>` : ''
    const dx = (o.bg ? 10 : 4) + indent
    row += `<circle cx="${dx}" cy="${cy}" r="3" ${fill(c)}>${a.state === 'running' ? '<animate attributeName="opacity" values="1;.35;1" dur="1.4s" repeatCount="indefinite"/>' : ''}</circle>`
    const name = fit((a.depth > 0 ? '↳ ' : '') + a.title, px, W * 0.45, o.mono)
    const nx = dx + 9
    row += `<text x="${nx}" y="${cy + 4}" font-family="${family}" font-size="${px}" ${fill('var(--ink)')}>${esc(name)}</text>`
    if (W > 300) row += `<text x="${n1(nx + textWidth(name, px, o.mono) + 8)}" y="${cy + 4}" font-family="${family}" font-size="${px}" ${fill(c)}>${esc(a.tool)}</text>`
    row += `<text x="${W - (o.bg ? 9 : 2)}" y="${cy + 4}" text-anchor="end" font-family="${SANS}" font-size="11" ${fill('var(--muted)')}>${elapsed((a.endedAt ?? now) - a.startedAt)}</text>`
    rows.push(row)
  })
  if (v.hidden.length > 0) {
    const y = v.shown.length * (RH + GAP)
    const done = v.hidden.filter(a => a.state === 'done').length
    rows.push(
      (o.bg ? `<rect x="0" y="${y}" width="${W}" height="${RH}" rx="${RH / 2}" ${fill('var(--faint)', 0.35)}/>` : '') +
        `<text x="${o.bg ? 10 : 4}" y="${y + RH / 2 + 4}" font-family="${family}" font-size="${px}" ${fill('var(--muted)')}>+${v.hidden.length} more · ${done} done</text>`,
    )
  }
  const count = rows.length
  return { body: rows.join(''), height: count ? count * (RH + GAP) - GAP : 0 }
}

function withStrips(body: string, trackH: number, W: number, now: number, v: Visible | null, o: StripLook): Drawn {
  if (!v) return { svg: svg(W, trackH, body), height: trackH }
  const s = strips(v, W, now, o)
  const off = trackH + 6
  return { svg: svg(W, off + s.height, `${body}<g transform="translate(0 ${off})">${s.body}</g>`), height: off + s.height }
}

// ---------- segments: one cell per stage, every stage name visible ----------
// the current stage is the loudest cell; finished ones fade to a tint. When the plan waits on the person or fails,
// only the step at fault takes the amber or red, so it stands out from the clay. A stage too narrow for its name
// shrinks to a thin bar, and the count lives only right of the bar

const segments: BarStyle = {
  glyph: p => glyphFor(p, GLYPH_COLOR.clay),
  right: stepCount,
  draw(p, W, now, agents) {
    const H = 22
    const gap = 2
    const px = 11.5
    const n = Math.max(1, p.stages.length)
    const allDone = p.state === 'done'
    const w = where(p)
    const cs = allDone ? -1 : w.stage
    const avail = W - gap * (n - 1)
    // each stage's width follows its step count; the current one is widened to fit its name when it can be
    const steps = p.stages.map(s => Math.max(1, s.steps.length))
    const sum = steps.reduce((a, b) => a + b, 0)
    let widths = steps.map(k => (avail * k) / sum)
    const curName = p.stages[cs]?.name ?? ''
    const curMin = textWidth(curName, px) + 18
    if (cs >= 0 && (widths[cs] ?? 0) < curMin && avail - curMin > (n - 1) * 8) {
      const rest = sum - (steps[cs] ?? 0)
      widths = steps.map((k, i) => (i === cs ? curMin : ((avail - curMin) * k) / Math.max(1, rest)))
    }
    // the solid fills behind white letters are a shade deeper in the light scheme, so the letters stay readable
    const solid = allDone ? 'var(--greenS)' : 'var(--clayS)'
    const fault = p.state === 'needs_input' ? 'var(--amber)' : p.state === 'error' ? 'var(--red)' : null
    let x = 0
    let defs = ''
    let out = ''
    p.stages.forEach((s, i) => {
      const sw = widths[i] ?? 0
      const k = Math.max(1, s.steps.length)
      const stepW = sw / k
      const doneN = s.steps.filter(t => fin(t.status)).length
      const isCur = i === cs
      const isDone = allDone || (!isCur && doneN === s.steps.length && s.steps.length > 0)
      let label = fit(s.name, px, sw - 16)
      // a stage with no room for its name is a thin bar, not an empty cell
      const isThin = !isCur && !allDone && (label === '' || label.length < Math.min(3, s.name.length))
      if (isThin) label = ''
      const y = isThin ? 8 : 0
      const h = isThin ? 6 : H
      let g = `<rect x="${n1(x)}" y="${y}" width="${n1(sw)}" height="${h}" ${fill('var(--track)')}/>`
      let labelFill: string | null = null
      if (allDone) {
        g += `<rect x="${n1(x)}" y="0" width="${n1(sw)}" height="${H}" ${fill(solid)}/>`
      } else if (isDone) {
        g += `<rect x="${n1(x)}" y="${y}" width="${n1(sw)}" height="${h}" ${fill(fault ? 'var(--ink)' : 'var(--clayS)', fault ? 0.12 : 0.26)}/>`
      } else if (isCur) {
        // one fill over the whole stage: solid over its finished steps, fading through the active one to a tint, so
        // there is no hard edge where the finished part stops. The middle of the fade breathes, slowly, eased
        const curIdx = Math.max(0, s.steps.findIndex(t => !fin(t.status)))
        const at = (v: number) => n1(Math.min(100, Math.max(0, ((v - x) / Math.max(1, sw)) * 100)))
        const d = x + stepW * curIdx
        const m = d + stepW * 0.5
        const e2 = d + stepW
        const [head, headOp] = fault ? ['var(--ink)', 0.22] : ['var(--clayS)', 1]
        const tone = fault ?? 'var(--clayS)'
        const [lo, hi] = fault ? [0.25, 0.6] : [0.35, 0.7]
        const breathe = `<animate attributeName="stop-opacity" values="${hi};${lo};${hi}" keyTimes="0;.5;1" calcMode="spline" keySplines=".45 0 .55 1;.45 0 .55 1" dur="2.4s" repeatCount="indefinite"/>`
        const stop = (v: number, c: string, op: number, alive = false) => `<stop offset="${at(v)}%" style="stop-color:${c}" stop-opacity="${op}">${alive ? breathe : ''}</stop>`
        // nothing finished yet in this stage: no solid head, the fade starts at its left edge
        const headStops = curIdx > 0 ? stop(x, head, headOp) + stop(d, head, headOp) : ''
        // running: the solid part fades out through the active step. Waiting or failed: the active step is one soft
        // band of amber or red between the grey finished part and the tint
        const bodyStops = fault
          ? stop(d + stepW * 0.3, tone, hi, true) + stop(e2 - stepW * 0.2, tone, hi, true) + stop(Math.min(x + sw, e2 + stepW * 0.3), tone, 0.14)
          : stop(curIdx > 0 ? m : x, tone, hi, true) + stop(e2, tone, 0.14)
        defs += `<linearGradient id="g${i}" gradientUnits="userSpaceOnUse" x1="${n1(x)}" x2="${n1(x + sw)}" y1="0" y2="0">${headStops}${bodyStops}${stop(x + sw, tone, 0.14)}</linearGradient>`
        g += `<rect x="${n1(x)}" y="0" width="${n1(sw)}" height="${H}" fill="url(#g${i})"/>`
        // the name turns light over the solid part and back to ink through the same fade
        if (!fault && curIdx > 0) {
          defs += `<linearGradient id="t${i}" gradientUnits="userSpaceOnUse" x1="${n1(x)}" x2="${n1(x + sw)}" y1="0" y2="0"><stop offset="${at(d)}%" style="stop-color:var(--on)"/><stop offset="${at(m)}%" style="stop-color:var(--ink)"/></linearGradient>`
          labelFill = `fill="url(#t${i})"`
        }
      }
      if (label) g += `<text x="${n1(x + 8)}" y="15" font-family="${SANS}" font-size="${px}" font-weight="${isCur ? 600 : 500}" ${labelFill ?? fill(allDone ? 'var(--on)' : isCur ? 'var(--ink)' : 'var(--muted)')}>${esc(label)}</text>`
      out += g
      x += sw + gap
    })
    // one rounded outline for the whole bar, so the cells read as one bar, not a row of buttons
    defs += `<clipPath id="bar"><rect x="0" y="0" width="${n1(Math.max(0, x - gap))}" height="${H}" rx="6"/></clipPath>`
    return withStrips(`<defs>${defs}</defs><g clip-path="url(#bar)">${out}</g>`, H, W, now, agents, { accent: 'var(--clay)', bg: true })
  },
}

// ---------- hairline: a 2px line with a breathing head, ink until something needs attention ----------

const hairline: BarStyle = {
  glyph: () => null,
  right: (p, now) => (p.state === 'done' ? 'Done' : elapsed(now - p.startedAt)),
  draw(p, W, now, agents) {
    const H = 22
    const w = where(p)
    const done = p.state === 'done'
    const c = done ? 'var(--green)' : p.state === 'running' ? 'var(--ink)' : stateVar(p.state, 'var(--ink)')
    const sName = done ? 'Done' : (p.stages[w.stage]?.name ?? '')
    const stepT = done ? '' : (p.state !== 'running' && p.note) || w.title
    const nW = textWidth(sName, 12) * 1.05
    const sT = fit(stepT, 12, Math.max(0, W * 0.42 - nW - 8))
    const labelW = nW + (sT ? 8 + textWidth(sT, 12) : 0)
    let out = `<text x="0" y="15" font-family="${SANS}" font-size="12"><tspan font-weight="500" ${fill(done ? 'var(--green)' : 'var(--ink)')}>${esc(sName)}</tspan>${sT ? `<tspan dx="8" ${fill(p.state === 'running' ? 'var(--muted)' : c)}>${esc(sT)}</tspan>` : ''}</text>`
    const cnt = stepCount(p)
    const L = labelW + 16
    const R = W - textWidth(cnt, 11) - 12
    out += `<text x="${W}" y="15" text-anchor="end" font-family="${SANS}" font-size="11" ${fill('var(--muted)')}>${cnt}</text>`
    const X = (k: number) => L + (k / Math.max(1, w.total)) * (R - L)
    const fx = X(done ? w.total : w.pos)
    let k = 0
    for (const s of p.stages) {
      const a = X(k) + (k ? 2 : 0)
      const end = k + s.steps.length
      const b = X(end) - (end < w.total ? 2 : 0)
      out += `<rect x="${n1(a)}" y="10" width="${n1(Math.max(0, b - a))}" height="2" rx="1" ${fill('var(--faint)', 0.55)}/>`
      if (fx > a) out += `<rect x="${n1(a)}" y="10" width="${n1(Math.max(0, Math.min(b, fx) - a))}" height="2" rx="1" ${fill(done ? 'var(--green)' : 'var(--ink)', done ? 1 : 0.85)}/>`
      k = end
    }
    if (done) {
      out += `<circle cx="${n1(R)}" cy="11" r="6" ${fill('var(--green)')}/><path d="M${n1(R - 2.6)} 11.2l1.8 1.8 3.4-3.6" style="fill:none;stroke:var(--on);stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round"/>`
    } else if (p.state === 'needs_input') {
      out += `<circle cx="${n1(fx)}" cy="11" r="5" ${ring(c, 2)}><animate attributeName="stroke-opacity" values="1;.35;1" dur="1.8s" repeatCount="indefinite"/></circle>`
    } else {
      if (p.state === 'running') out += `<circle cx="${n1(fx)}" cy="11" r="4" ${fill(c, 0.3)}><animate attributeName="r" values="4;10" dur="1.8s" repeatCount="indefinite" calcMode="spline" keyTimes="0;1" keySplines=".2 .8 .3 1"/><animate attributeName="fill-opacity" values=".3;0" dur="1.8s" repeatCount="indefinite"/></circle>`
      out += `<circle cx="${n1(fx)}" cy="11" r="${p.state === 'error' ? 5 : 4}" ${fill(c)}/>`
      if (p.state === 'error') out += `<path d="M${n1(fx - 2)} 9l4 4M${n1(fx + 2)} 9l-4 4" style="stroke:var(--on);stroke-width:1.4;stroke-linecap:round"/>`
    }
    return withStrips(out, H, W, now, agents, { accent: 'var(--ink)', bg: false })
  },
}

// ---------- beads: one bead per step, a stage's beads strung together ----------

const beads: BarStyle = {
  glyph: p => glyphFor(p, GLYPH_COLOR.blue),
  right: percent,
  draw(p, W, now, agents) {
    const H = 22
    const cy = 11
    const w = where(p)
    const done = p.state === 'done'
    const acc = done ? 'var(--green)' : 'var(--blue)'
    let sp = 15
    let sg = 14
    const need = () => p.stages.reduce((a, s) => a + (s.steps.length - 1) * sp + 10, 0) + (p.stages.length - 1) * sg
    while (need() > W * 0.55 && sp > 7) {
      sp -= 1
      sg = Math.max(8, sg - 0.6)
    }
    let x = 6
    let out = ''
    for (const s of p.stages) {
      const xs = s.steps.map((_, j) => x + j * sp)
      for (let j = 1; j < xs.length; j++) {
        const on = fin(s.steps[j]?.status ?? 'pending')
        out += `<rect x="${n1(xs[j - 1] ?? 0)}" y="${cy - 0.75}" width="${n1(sp)}" height="1.5" ${fill(on ? acc : 'var(--faint)', on ? 0.9 : 0.6)}/>`
      }
      s.steps.forEach((st, j) => {
        const bx = n1(xs[j] ?? 0)
        if (fin(st.status)) out += `<circle cx="${bx}" cy="${cy}" r="4.5" ${fill(acc)}/>`
        else if (st.status === 'error') out += `<circle cx="${bx}" cy="${cy}" r="5.5" ${fill('var(--red)')}/><path d="M${n1(Number(bx) - 2)} ${cy - 2}l4 4M${n1(Number(bx) + 2)} ${cy - 2}l-4 4" style="stroke:var(--on);stroke-width:1.4;stroke-linecap:round"/>`
        else if (st.status === 'active') {
          const c = p.state === 'needs_input' ? 'var(--amber)' : acc
          out += `<circle cx="${bx}" cy="${cy}" r="5.5" ${ring(c, 1.8)}/><circle cx="${bx}" cy="${cy}" r="2.4" ${fill(c)}><animate attributeName="r" values="2;3.2;2" dur="${p.state === 'needs_input' ? 1.8 : 1.2}s" repeatCount="indefinite"/></circle>`
        } else out += `<circle cx="${bx}" cy="${cy}" r="3.6" ${ring('var(--faint)', 1.5)}/>`
      })
      x = (xs[xs.length - 1] ?? x) + 10 + sg - 4
    }
    const lx = x + 4
    const sName = done ? 'Done' : (p.stages[w.stage]?.name ?? '')
    const stepT = done ? '' : (p.state !== 'running' && p.note) || w.title
    const room = W - lx
    const nW = textWidth(sName, 12) * 1.05
    const sT = fit(stepT, 12, room - nW - 22)
    if (room > nW) out += `<text x="${n1(lx)}" y="15" font-family="${SANS}" font-size="12"><tspan font-weight="500" ${fill(done ? 'var(--green)' : 'var(--ink)')}>${esc(sName)}</tspan>${sT ? `<tspan dx="6" ${fill('var(--muted)')}>· ${esc(sT)}</tspan>` : ''}</text>`
    return withStrips(out, H, W, now, agents, { accent: 'var(--blue)', bg: false })
  },
}

// ---------- ledger: mono stage names and a row of cells, the active cell blinks like a cursor ----------

const ledger: BarStyle = {
  glyph: () => null,
  right: stepCount,
  draw(p, W, now, agents) {
    const H = 22
    const done = p.state === 'done'
    const w = where(p)
    const cw = 6
    const cg = 3
    const lg = 7
    const sgap = 14
    const px = 10.5
    const cellsW = (n: number) => n * (cw + cg) - cg
    const nameOf = (name: string, mode: 'full' | 'short') => (mode === 'short' ? name.slice(0, 3) : name).toUpperCase()
    const width = (mode: 'full' | 'short' | 'none') =>
      p.stages.reduce((a, s) => a + (mode === 'none' ? 0 : textWidth(nameOf(s.name, mode), px, true) * 1.04 + lg) + cellsW(s.steps.length), 0) + (p.stages.length - 1) * sgap
    const mode = width('full') <= W * 0.78 ? 'full' : width('short') <= W * 0.9 ? 'short' : 'none'
    let x = 0
    let out = ''
    p.stages.forEach((s, i) => {
      const isCur = !done && i === w.stage
      const allDone = s.steps.every(t => fin(t.status))
      if (mode !== 'none') {
        const name = nameOf(s.name, mode)
        out += `<text x="${n1(x)}" y="15" font-family="${MONO}" font-size="${px}" font-weight="${isCur ? 700 : 500}" letter-spacing=".04em" ${fill(isCur ? 'var(--ink)' : 'var(--muted)', isCur || allDone ? 1 : 0.7)}>${esc(name)}</text>`
        x += textWidth(name, px, true) * 1.04 + lg
      }
      for (const st of s.steps) {
        if (done) out += `<rect x="${n1(x)}" y="5" width="${cw}" height="12" rx="1.5" ${fill('var(--green)')}/>`
        else if (fin(st.status)) out += `<rect x="${n1(x)}" y="5" width="${cw}" height="12" rx="1.5" ${fill('var(--ink)', 0.72)}/>`
        else if (st.status === 'error') out += `<rect x="${n1(x)}" y="5" width="${cw}" height="12" rx="1.5" ${fill('var(--red)')}/>`
        else if (st.status === 'active') {
          const c = p.state === 'needs_input' ? 'var(--amber)' : 'var(--ink)'
          out += `<rect x="${n1(x)}" y="5" width="${cw}" height="12" rx="1.5" ${fill(c)}><animate attributeName="opacity" values="1;1;.15;.15" keyTimes="0;.5;.5;1" dur="1.05s" repeatCount="indefinite"/></rect>`
        } else out += `<rect x="${n1(x + 0.6)}" y="5.6" width="${cw - 1.2}" height="10.8" rx="1.2" style="fill:none;stroke:var(--faint);stroke-width:1.2"/>`
        x += cw + cg
      }
      x += sgap - cg
    })
    const label = done ? 'Done' : (p.state !== 'running' && p.note) || w.title
    const lc = done ? 'var(--green)' : p.state === 'running' ? 'var(--muted)' : stateVar(p.state, 'var(--ink)')
    const t = fit(label, 12, W - x - 4)
    if (t) out += `<text x="${n1(x)}" y="15" font-family="${SANS}" font-size="12" ${fill(lc)}>${esc(t)}</text>`
    return withStrips(out, H, W, now, agents, { accent: 'var(--ink)', bg: false, mono: true })
  },
}

// ---------- transit: stages as stretches of a line, names below, a train moving along ----------

const transit: BarStyle = {
  glyph: p => glyphFor(p, GLYPH_COLOR.violet),
  right: percent,
  draw(p, W, now, agents) {
    const H = 36
    const cy = 10
    const pad = 7
    const w = where(p)
    const done = p.state === 'done'
    const c = done ? 'var(--green)' : stateVar(p.state, 'var(--violet)')
    const lineC = done ? 'var(--green)' : 'var(--violet)'
    const L = pad
    const R = W - pad
    const X = (k: number) => L + (k / Math.max(1, w.total)) * (R - L)
    const pos = done ? w.total : w.pos
    let out = `<rect x="${L}" y="${cy - 1.5}" width="${n1(R - L)}" height="3" rx="1.5" ${fill('var(--faint)', 0.5)}/>`
    out += `<rect x="${L}" y="${cy - 1.5}" width="${n1(X(pos) - L)}" height="3" rx="1.5" ${fill(lineC)}/>`
    const bounds = [0]
    for (const s of p.stages) bounds.push((bounds[bounds.length - 1] ?? 0) + s.steps.length)
    for (let k = 1; k < w.total; k++) if (!bounds.includes(k)) out += `<circle cx="${n1(X(k))}" cy="${cy}" r="1.4" ${fill(k <= pos ? 'var(--panel)' : 'var(--faint)')}/>`
    bounds.forEach((k, i) => {
      const passed = k <= pos
      const last = i === bounds.length - 1
      out += `<circle cx="${n1(X(k))}" cy="${cy}" r="${last ? 5.5 : 4.5}" style="fill:${passed ? lineC : 'var(--panel)'};stroke:${passed ? 'var(--panel)' : 'var(--faint)'};stroke-width:${passed ? 2 : 1.6}"/>`
      if (last && done) out += `<path d="M${n1(X(k) - 2.4)} ${cy + 0.2}l1.6 1.6 3.2-3.4" style="fill:none;stroke:var(--on);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round"/>`
    })
    if (!done) {
      const tx = X(pos + 0.5)
      if (p.state === 'running') out += `<circle cx="${n1(tx)}" cy="${cy}" r="6" ${fill(c, 0.28)}><animate attributeName="r" values="6;12" dur="1.8s" repeatCount="indefinite" calcMode="spline" keyTimes="0;1" keySplines=".2 .8 .3 1"/><animate attributeName="fill-opacity" values=".28;0" dur="1.8s" repeatCount="indefinite"/></circle>`
      out += `<rect x="${n1(tx - 9)}" y="${cy - 5.5}" width="18" height="11" rx="5.5" style="fill:${c};stroke:var(--panel);stroke-width:2"/>`
      if (p.state === 'needs_input') out += `<text x="${n1(tx)}" y="${cy + 3.6}" text-anchor="middle" font-family="${SANS}" font-size="9.5" font-weight="700" ${fill('var(--on)')}>?</text>`
      else if (p.state === 'error') out += `<path d="M${n1(tx - 2)} ${cy - 2}l4 4M${n1(tx + 2)} ${cy - 2}l-4 4" style="stroke:var(--on);stroke-width:1.4;stroke-linecap:round"/>`
      else out += `<circle cx="${n1(tx - 3)}" cy="${cy}" r="1.2" ${fill('var(--on)')}/><circle cx="${n1(tx + 1)}" cy="${cy}" r="1.2" ${fill('var(--on)')}/><circle cx="${n1(tx + 5)}" cy="${cy}" r="1.2" ${fill('var(--on)', 0.5)}/>`
    }
    p.stages.forEach((s, i) => {
      const a = X(bounds[i] ?? 0)
      const b = X(bounds[i + 1] ?? 0)
      const isCur = !done && i === w.stage
      const passed = (bounds[i + 1] ?? 0) <= pos
      const px = 10.5
      let label = isCur ? `${s.name} ${w.step}/${w.stageSize}` : s.name
      if (textWidth(label, px) > b - a - 6) label = fit(s.name, px, b - a - 6)
      if (label) out += `<text x="${n1((a + b) / 2)}" y="${cy + 21}" text-anchor="middle" font-family="${SANS}" font-size="${px}" font-weight="${isCur ? 600 : 500}" ${fill(isCur ? 'var(--ink)' : 'var(--muted)', isCur || passed ? 1 : 0.7)}>${esc(label)}</text>`
    })
    return withStrips(out, H, W, now, agents, { accent: 'var(--violet)', bg: true, tint: 0.1 })
  },
}

// ---------- grid: one small square per step, two to a column, a stage's squares set apart ----------

const grid: BarStyle = {
  glyph: p => glyphFor(p, GLYPH_COLOR.teal),
  right: stepCount,
  draw(p, W, now, agents) {
    const H = 22
    const w = where(p)
    const done = p.state === 'done'
    const acc = done ? 'var(--green)' : 'var(--teal)'
    // squares shrink when a long plan would take more than half the bar
    let cell = 7
    let cg = 2
    let sgap = 7
    const cols = (k: number) => Math.ceil(Math.max(1, k) / 2)
    const need = () => p.stages.reduce((a, s) => a + cols(s.steps.length) * (cell + cg) - cg, 0) + (p.stages.length - 1) * sgap
    while (need() > W * 0.5 && cell > 4) {
      cell -= 1
      cg = Math.max(1, cg - 0.5)
      sgap = Math.max(4, sgap - 1)
    }
    const top = (H - (cell * 2 + cg)) / 2
    let x = 0
    let out = ''
    for (const s of p.stages) {
      s.steps.forEach((st, j) => {
        const cx = n1(x + Math.floor(j / 2) * (cell + cg))
        // a column holding one square, the last of an odd stage, puts it at the middle
        const isAlone = j % 2 === 0 && j === s.steps.length - 1
        const cy = n1(isAlone ? (H - cell) / 2 : top + (j % 2) * (cell + cg))
        const box = `x="${cx}" y="${cy}" width="${cell}" height="${cell}" rx="${cell > 5 ? 1.5 : 1}"`
        if (st.status === 'done') out += `<rect ${box} ${fill(acc)}/>`
        else if (st.status === 'skipped') out += `<rect ${box} ${fill(acc, 0.4)}/>`
        else if (st.status === 'error') out += `<rect ${box} ${fill('var(--red)')}/>`
        else if (st.status === 'active') {
          const c = p.state === 'needs_input' ? 'var(--amber)' : acc
          out += `<rect ${box} ${fill(c)}><animate attributeName="fill-opacity" values="1;.3;1" dur="${p.state === 'needs_input' ? 1.8 : 1.2}s" repeatCount="indefinite"/></rect>`
        } else out += `<rect x="${n1(Number(cx) + 0.5)}" y="${n1(Number(cy) + 0.5)}" width="${cell - 1}" height="${cell - 1}" rx="${cell > 5 ? 1.2 : 0.8}" style="fill:none;stroke:var(--faint);stroke-width:1"/>`
      })
      x += cols(s.steps.length) * (cell + cg) - cg + sgap
    }
    const lx = x - sgap + 12
    const sName = done ? 'Done' : (p.stages[w.stage]?.name ?? '')
    const stepT = done ? '' : (p.state !== 'running' && p.note) || w.title
    const room = W - lx
    const nW = textWidth(sName, 12) * 1.05
    const sT = fit(stepT, 12, room - nW - 22)
    if (room > nW) out += `<text x="${n1(lx)}" y="15" font-family="${SANS}" font-size="12"><tspan font-weight="500" ${fill(done ? 'var(--green)' : 'var(--ink)')}>${esc(sName)}</tspan>${sT ? `<tspan dx="6" ${fill('var(--muted)')}>· ${esc(sT)}</tspan>` : ''}</text>`
    return withStrips(out, H, W, now, agents, { accent: 'var(--teal)', bg: false })
  },
}

export const STYLES: Record<Exclude<StyleId, 'original'>, BarStyle> = { segments, hairline, beads, ledger, transit, grid }
