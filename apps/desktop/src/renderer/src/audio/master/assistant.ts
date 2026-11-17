// Mastering assistant: measures a song (tone balance in eight bands, dynamics, stereo, loudness, clipping, silence)
// and proposes settings for the chain, each with a short reason. Rules on measurements, no AI model: it runs at once
// and offline. The tone balance is compared with a genre profile or with a reference song.
import { crossover, type Analysis } from './dsp'
import type { Chain, EqParams, Slot } from './chain'
import { slotDefaults } from './chain'
import type { EditOp } from './edit'

export const BANDS = [
  { id: 'sub', label: 'Sub bass', lo: 20, hi: 60 },
  { id: 'bass', label: 'Bass', lo: 60, hi: 150 },
  { id: 'lowmid', label: 'Low mids', lo: 150, hi: 400 },
  { id: 'mid', label: 'Mids', lo: 400, hi: 1000 },
  { id: 'upmid', label: 'Upper mids', lo: 1000, hi: 3000 },
  { id: 'presence', label: 'Presence', lo: 3000, hi: 6000 },
  { id: 'brilliance', label: 'Brilliance', lo: 6000, hi: 12000 },
  { id: 'air', label: 'Air', lo: 12000, hi: 20000 },
] as const
export type BandId = typeof BANDS[number]['id']

/** Energy per octave in each band, in dB relative to their average (a flat line = pink noise). */
export type Balance = Record<BandId, number>

export interface Profile {
  id: string
  label: string
  balance: Balance           // target tone balance (same scale as Balance)
  crest: [number, number]    // the crest factor range (dB) that suits the style
  lufs: number               // usual loudness
  target: string             // id in TARGETS
  monoBelow: number          // bass in mono below (Hz)
}

// Target balances: energy per octave relative to the mean, as measured on typical modern masters of each style
// (a falling line: music has less energy per octave in the highs than pink noise). Deliberately smooth; the
// assistant only acts on clear differences (more than 2 dB) and never by more than 4 dB at once.
const P = (sub: number, bass: number, lowmid: number, mid: number, upmid: number, presence: number, brilliance: number, air: number): Balance =>
  ({ sub, bass, lowmid, mid, upmid, presence, brilliance, air })
export const PROFILES: Profile[] = [
  { id: 'techno', label: 'Techno / House', balance: P(6, 7, 3, 0, -2, -3, -4, -7), crest: [7, 10], lufs: -9, target: 'loud', monoBelow: 150 },
  { id: 'afro', label: 'Afro House', balance: P(5, 7, 3, 0, -1, -3, -4, -7), crest: [7, 11], lufs: -9, target: 'loud', monoBelow: 140 },
  { id: 'trance', label: 'Trance / EDM', balance: P(5, 6, 2, 0, -1, -2, -3, -6), crest: [6, 9], lufs: -8, target: 'loud', monoBelow: 140 },
  { id: 'pop', label: 'Pop', balance: P(3, 5, 3, 1, 0, -2, -3, -6), crest: [8, 11], lufs: -11, target: 'streaming', monoBelow: 120 },
  { id: 'hiphop', label: 'Hip-hop', balance: P(7, 7, 3, 0, -2, -3, -4, -8), crest: [8, 11], lufs: -10, target: 'streaming', monoBelow: 140 },
  { id: 'rock', label: 'Rock', balance: P(1, 4, 4, 2, 1, -1, -3, -7), crest: [8, 12], lufs: -10, target: 'streaming', monoBelow: 110 },
  { id: 'soul', label: 'Soul / R&B', balance: P(3, 5, 4, 2, 0, -2, -4, -7), crest: [9, 13], lufs: -12, target: 'streaming', monoBelow: 120 },
  { id: 'funk', label: 'Funk', balance: P(2, 6, 3, 2, 1, -1, -3, -7), crest: [9, 13], lufs: -11, target: 'streaming', monoBelow: 120 },
  { id: 'acoustic', label: 'Acoustic / singer-songwriter', balance: P(-2, 3, 4, 2, 1, -1, -3, -6), crest: [11, 16], lufs: -14, target: 'streaming', monoBelow: 100 },
  { id: 'podcast', label: 'Podcast / speech', balance: P(-8, 0, 3, 4, 3, 1, -3, -9), crest: [10, 15], lufs: -16, target: 'podcast', monoBelow: 150 },
]

/** Tone balance of a song: band energies (Linkwitz-Riley splits of the mid signal), per octave, relative to the mean. */
export function measureBalance(ch: Float32Array[], sr: number): Balance {
  const n = ch[0].length
  const mid = new Float32Array(n)
  for (let i = 0; i < n; i++) mid[i] = (ch[0][i] + (ch[1] ?? ch[0])[i]) * 0.5
  const edges = BANDS.slice(1).map((b) => b.lo)                 // 60 150 400 1000 3000 6000 12000
  // split the signal step by step: low part of edge k = band k, the rest continues upwards
  const run = (x: Float32Array, c: number[]): Float32Array => {
    const y = new Float32Array(x.length)
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0
    for (let i = 0; i < x.length; i++) {
      const v = c[0] * x[i] + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v
    }
    return y
  }
  const energy: number[] = []
  const hp20 = crossover(sr, 20).high                            // nothing below 20 Hz counts as sub bass
  let rest = run(run(mid, hp20), hp20)
  for (const f of edges) {
    const xo = crossover(sr, f)
    const low = run(run(rest, xo.low), xo.low)
    rest = run(run(rest, xo.high), xo.high)
    let e = 0
    for (let i = 0; i < low.length; i++) e += low[i] * low[i]
    energy.push(e)
  }
  let e = 0
  for (let i = 0; i < rest.length; i++) e += rest[i] * rest[i]
  energy.push(e)
  // the top band reaches up to half the sample rate
  const octaves = (k: number): number => Math.log2((k === BANDS.length - 1 ? sr / 2 : BANDS[k].hi) / BANDS[k].lo)
  const perOct = energy.map((v, k) => 10 * Math.log10(Math.max(v, 1e-12) / octaves(k)))
  const mean = perOct.reduce((a, b) => a + b, 0) / perOct.length
  return Object.fromEntries(BANDS.map((b, k) => [b.id, Math.round((perOct[k] - mean) * 10) / 10])) as Balance
}

/** How much of the bass (below 150 Hz) is on the sides: 0 = mono bass, 1 = as much side as mid. */
export function bassWidth(ch: Float32Array[], sr: number): number {
  if (ch.length < 2) return 0
  const xo = crossover(sr, 150).low
  let m1 = 0, m2 = 0, n1 = 0, n2 = 0, s1 = 0, s2 = 0, t1 = 0, t2 = 0, em = 0, es = 0
  const L = ch[0], R = ch[1]
  for (let i = 0; i < L.length; i++) {
    const m = (L[i] + R[i]) * 0.5, s = (L[i] - R[i]) * 0.5
    const ym = xo[0] * m + xo[1] * m1 + xo[2] * m2 - xo[3] * n1 - xo[4] * n2
    m2 = m1; m1 = m; n2 = n1; n1 = ym
    const ys = xo[0] * s + xo[1] * s1 + xo[2] * s2 - xo[3] * t1 - xo[4] * t2
    s2 = s1; s1 = s; t2 = t1; t1 = ys
    em += ym * ym; es += ys * ys
  }
  return em > 0 ? Math.sqrt(es / em) : 0
}

export interface Suggestion {
  id: string
  area: 'tone' | 'dynamics' | 'stereo' | 'loudness' | 'edit' | 'note'
  text: string                         // what it does and why, in one sentence
  apply?: (c: Chain) => Chain          // a change to the chain
  edit?: EditOp                        // a change to the file
  reach?: boolean                      // set the loudness target afterwards
  on: boolean                          // ticked by default
}

const eqOf = (c: Chain): Slot & { type: 'eq' } => (c.slots.find((s) => s.type === 'eq') as Slot & { type: 'eq' }) ?? (slotDefaults('eq', 'eq1') as Slot & { type: 'eq' })
const withEq = (c: Chain, f: (p: EqParams) => EqParams): Chain => {
  const has = c.slots.some((s) => s.type === 'eq')
  const eq = eqOf(c)
  const next = { ...eq, on: true, p: f(eq.p) } as Slot
  return { ...c, slots: has ? c.slots.map((s) => (s.type === 'eq' ? next : s)) : [next, ...c.slots] }
}
const withSlot = (c: Chain, type: Slot['type'], f: (s: Slot) => Slot): Chain => {
  const has = c.slots.some((s) => s.type === type)
  const base = (c.slots.find((s) => s.type === type) ?? slotDefaults(type, `${type}${Date.now().toString(36)}`)) as Slot
  const next = f({ ...base, on: true } as Slot)
  return { ...c, slots: has ? c.slots.map((s) => (s.type === type ? next : s)) : [...c.slots, next] }
}
const r1 = (v: number): number => Math.round(v * 2) / 2

const BAND_DE: Record<BandId, string> = {
  sub: 'Sub-Bass', bass: 'Bass', lowmid: 'Untere Mitten', mid: 'Mitten', upmid: 'Obere Mitten', presence: 'Präsenz', brilliance: 'Brillanz', air: 'Luft',
}
const PROFILE_DE: Record<string, string> = { acoustic: 'Akustik / Singer-Songwriter', podcast: 'Podcast / Sprache' }
/** Names in the language of the app ("de" or English). */
export const bandLabel = (id: BandId, lang = 'en'): string => (lang === 'de' ? BAND_DE[id] : BANDS.find((b) => b.id === id)!.label)
export const profileLabel = (p: Profile, lang = 'en'): string => (lang === 'de' ? PROFILE_DE[p.id] ?? p.label : p.label)

/** The proposals for a song. `ref` (a reference song's balance) replaces the profile's balance when given.
 *  `lang`: "de" for German texts, anything else English. */
export function suggest(a: Analysis, bal: Balance, width: number, profile: Profile, ref?: Balance | null,
  silence?: { start: number; end: number }, lang = 'en'): Suggestion[] {
  const de = lang === 'de'
  const T = (en: string, d: string): string => (de ? d : en)
  const n1 = (v: number): string => (de ? v.toFixed(1).replace('.', ',') : v.toFixed(1))
  const sg = (v: number): string => `${v > 0 ? '+' : ''}${n1(v)}`
  const out: Suggestion[] = []
  const target = ref ?? profile.balance
  const diff = (b: BandId): number => bal[b] - target[b]
  const amount = (d: number): number => -Math.max(-4, Math.min(4, r1(d * 0.6)))    // move 60 % of the way, at most 4 dB
  const pl = profileLabel(profile, lang)
  const what = ref ? T('the reference', 'der Referenz') : pl
  const say = (b: BandId, d: number): string => de
    ? `${bandLabel(b, lang)} ${sg(d)} dB ${d > 0 ? 'über' : 'unter'} ${ref ? 'der Referenz' : pl}`
    : `${bandLabel(b)} ${sg(d)} dB ${d > 0 ? 'above' : 'below'} ${what}`

  // tone: low end (shelf), boxiness (300 Hz), mids, harshness (dynamic EQ), air (shelf), rumble (low cut)
  const low = (diff('sub') + diff('bass')) / 2
  if (Math.abs(low) > 2) {
    const g = amount(low)
    out.push({ id: 'low', area: 'tone', on: true, text: `${say('bass', low)}: ${T('low shelf at 100 Hz', 'Low Shelf bei 100 Hz')} ${sg(g)} dB.`, apply: (c) => withEq(c, (p) => ({ ...p, lowF: 100, lowG: g })) })
  }
  if (diff('sub') > 4 && bal.sub > bal.bass) {
    out.push({ id: 'rumble', area: 'tone', on: true, text: T(`Much energy below 60 Hz (${n1(diff('sub'))} dB above ${what}): low cut at 28 Hz removes rumble you cannot hear but that eats loudness.`,
      `Viel Energie unter 60 Hz (${n1(diff('sub'))} dB über ${ref ? 'der Referenz' : pl}): Low Cut bei 28 Hz entfernt Rumpeln, das man nicht hört, das aber Lautheit kostet.`), apply: (c) => withEq(c, (p) => ({ ...p, lowCut: 28 })) })
  }
  if (diff('lowmid') > 2) {
    const g = amount(diff('lowmid'))
    out.push({ id: 'box', area: 'tone', on: true, text: `${say('lowmid', diff('lowmid'))} ${T('(sounds muddy or boxy): band 1 at 300 Hz', '(klingt mulmig oder pappig): Band 1 bei 300 Hz')} ${sg(g)} dB.`, apply: (c) => withEq(c, (p) => ({ ...p, p1F: 300, p1G: g, p1Q: 1.2 })) })
  }
  const mids = (diff('mid') + diff('upmid')) / 2
  if (Math.abs(mids) > 2) {
    const g = amount(mids)
    out.push({ id: 'mids', area: 'tone', on: true, text: `${say('mid', mids)}: ${T('band 2 at 1.2 kHz', 'Band 2 bei 1,2 kHz')} ${sg(g)} dB.`, apply: (c) => withEq(c, (p) => ({ ...p, p2F: 1200, p2G: g, p2Q: 0.8 })) })
  }
  if (diff('presence') > 2) {
    const range = Math.min(6, r1(diff('presence')))
    out.push({ id: 'harsh', area: 'tone', on: true, text: `${say('presence', diff('presence'))} ${T(`(can sound sharp): dynamic EQ at 3.5 kHz turns it down by up to ${range} dB only where it is loud.`, `(kann scharf klingen): Dynamischer EQ bei 3,5 kHz senkt nur dort, wo es laut wird, um bis zu ${n1(range)} dB.`)}`, apply: (c) => withSlot(c, 'dyneq', (x) => ({ ...x, p: { ...(slotDefaults('dyneq', x.id).p), freq: 3500, q: 1.2, thresholdDb: -30, ratio: 3, rangeDb: range } } as Slot)) })
  } else if (diff('presence') < -2) {
    const g = amount(diff('presence'))
    out.push({ id: 'presence', area: 'tone', on: true, text: `${say('presence', diff('presence'))} ${T('(voice and snare lack presence): band 3 at 4 kHz', '(Stimme und Snare fehlt Präsenz): Band 3 bei 4 kHz')} ${sg(g)} dB.`, apply: (c) => withEq(c, (p) => ({ ...p, p3F: 4000, p3G: g, p3Q: 1 })) })
  }
  const highs = (diff('brilliance') + diff('air')) / 2
  if (Math.abs(highs) > 2) {
    const g = amount(highs)
    out.push({ id: 'air', area: 'tone', on: true, text: `${say('air', highs)}: ${T('high shelf at 10 kHz', 'High Shelf bei 10 kHz')} ${sg(g)} dB.`, apply: (c) => withEq(c, (p) => ({ ...p, highF: 10000, highG: g })) })
  }
  if (highs < -4) {
    out.push({ id: 'excite', area: 'tone', on: false, text: T('The highs are very dull: a little exciter above 7 kHz adds air that a shelf alone cannot (try it, judge by ear).', 'Die Höhen sind sehr dumpf: etwas Exciter über 7 kHz bringt Luft, die ein Shelf allein nicht schafft (ausprobieren, nach Gehör entscheiden).'), apply: (c) => withSlot(c, 'saturation', (x) => ({ ...x, p: { ...(slotDefaults('saturation', x.id).p), mix: 0, driveDb: 0, exciteFreq: 7000, excite: 0.25 } } as Slot)) })
  }

  // dynamics
  const [lo, hi] = profile.crest
  if (a.crest > hi + 1) {
    const th = r1(Math.max(-40, Math.min(-6, a.rms + 6)))
    out.push({ id: 'glue', area: 'dynamics', on: true, text: T(`Very dynamic (crest factor ${n1(a.crest)} dB, ${pl} usually ${lo}–${hi}): compressor 2:1 from ${th} dB, slow attack, holds the mix together.`,
      `Sehr dynamisch (Crest-Faktor ${n1(a.crest)} dB, bei ${pl} meist ${lo}–${hi}): Kompressor 2:1 ab ${n1(th)} dB, langsame Attack, hält den Mix zusammen.`), apply: (c) => withSlot(c, 'comp', (x) => ({ ...x, p: { thresholdDb: th, ratio: 2, attackMs: 30, releaseMs: 200, kneeDb: 6, makeupDb: 0 } } as Slot)) })
  } else if (a.crest < lo - 1) {
    out.push({ id: 'squashed', area: 'dynamics', on: true, text: T(`Already strongly compressed (crest factor ${n1(a.crest)} dB): the compressor is switched off so the song keeps its punch.`, `Schon stark komprimiert (Crest-Faktor ${n1(a.crest)} dB): der Kompressor wird ausgeschaltet, damit der Song seinen Punch behält.`), apply: (c) => ({ ...c, slots: c.slots.map((x) => (x.type === 'comp' || x.type === 'multiband' ? { ...x, on: false } : x)) as Slot[] }) })
  }

  // stereo
  if (width > 0.35) {
    out.push({ id: 'monobass', area: 'stereo', on: true, text: T(`The bass is wide (side signal ${Math.round(width * 100)} % of the middle below 150 Hz): mono below ${profile.monoBelow} Hz gives a tighter low end that works on club systems and phones.`,
      `Der Bass ist breit (Seitensignal ${Math.round(width * 100)} % der Mitte unter 150 Hz): Mono unter ${profile.monoBelow} Hz gibt einen festeren Bass, der auf Club-Anlagen und Handys funktioniert.`), apply: (c) => withSlot(c, 'stereo', (x) => ({ ...x, p: { ...(x.p as object), width: (x.p as { width?: number }).width ?? 1, balance: (x.p as { balance?: number }).balance ?? 0, monoBelow: profile.monoBelow } } as Slot)) })
  }
  if (a.correlation < 0.2) {
    out.push({ id: 'phase', area: 'stereo', on: true, text: T(`The stereo correlation is low (${a.correlation.toFixed(2)}): parts may cancel in mono. Width 85 % makes it safer.`, `Die Stereo-Korrelation ist niedrig (${n1(a.correlation)}): in Mono können Teile verschwinden. Breite 85 % macht es sicherer.`), apply: (c) => withSlot(c, 'stereo', (x) => ({ ...x, p: { ...(x.p as object), width: 0.85 } } as Slot)) })
  }

  // file
  if (a.clips.length > 0) out.push({ id: 'clips', area: 'note', on: false, text: T(`The original already reaches 0 dBFS in ${a.clips.length} places: that distortion is in the file and cannot be removed here. If you can, export the mix 1–3 dB quieter.`, `Das Original erreicht schon an ${a.clips.length} Stellen 0 dBFS: diese Verzerrung steckt in der Datei und lässt sich hier nicht entfernen. Wenn möglich, den Mix 1–3 dB leiser exportieren.`) })
  if (silence && (silence.start > 0.3 || silence.end > 1)) {
    out.push({ id: 'trim', area: 'edit', on: true, text: T(`Silence at the start (${n1(silence.start)} s) or end (${n1(silence.end)} s): trim it.`, `Stille am Anfang (${n1(silence.start)} s) oder Ende (${n1(silence.end)} s): abschneiden.`), edit: { type: 'trim', thresholdDb: -60 } })
  }

  // loudness last
  out.push({ id: 'loud', area: 'loudness', on: true, reach: true, text: T(`Loudness: ${pl} is usually around ${profile.lufs} LUFS; the target is set and "Louder" is adjusted to reach it (true peak stays below the ceiling).`,
    `Lautheit: ${pl} liegt meist bei etwa ${profile.lufs} LUFS; das Ziel wird gesetzt und „Louder“ so eingestellt, dass es erreicht wird (der True Peak bleibt unter der Grenze).`) })
  return out
}

/** Seconds of near-silence at the start and the end. */
export function silenceAtEdges(ch: Float32Array[], sr: number, thresholdDb = -60): { start: number; end: number } {
  const thr = Math.pow(10, thresholdDb / 20), n = ch[0].length
  const loud = (i: number): boolean => ch.some((x) => Math.abs(x[i]) > thr)
  let a = 0, b = n
  while (a < n && !loud(a)) a++
  while (b > a && !loud(b - 1)) b--
  return { start: a / sr, end: (n - b) / sr }
}
