// ─── Speak English SRS engine ──────────────────────────────────────────────
// Every card — a bare word OR an individual conjugation of a word — is its own
// independent card with its own level on the 0 → 7 fluency ladder.
//
// Built for decks of THOUSANDS: brand-new cards are not "due" — they are
// introduced gradually at a daily quota, while due reviews always come first.

import { EN_CONJUGATIONS, EN_WORDS } from '@/data/enDeck'
import { EN_VERB_FORMS, type VerbRow } from '@/data/enVerbForms'

export type CardKind = 'word' | 'conjugation'

export interface Card {
  id: string
  front: string
  back: string
  kind: CardKind
  /** The lemma this card belongs to (e.g. "speak"). Conjugations of the same
   *  word share a base but are still separate cards with separate levels. */
  base?: string
  note?: string
  level: number // 0..FLUENT_LEVEL
  due: number // epoch ms (only meaningful once introduced)
  /** false = still in the "new" backlog, waiting for the daily quota */
  introduced: boolean
  createdAt: number
  reviews: number
  lapses: number
}

export type Grade = 'again' | 'hard' | 'good' | 'easy'

export const FLUENT_LEVEL = 7

export const LEVEL_NAMES = [
  '新出',
  '見た',
  '学習中',
  '見覚え',
  '知ってる',
  '強い',
  '習得',
  '流暢',
] as const

// Minutes a card waits after reaching each level (index = level just reached).
export const LEVEL_INTERVALS_MIN = [
  10, // 0  New        → 10 min
  240, // 1  Seen       → 4 h
  1440, // 2  Learning  → 1 d
  3600, // 3  Familiar  → 2.5 d
  8640, // 4  Known     → 6 d
  20160, // 5  Strong   → 14 d
  50400, // 6  Mastered → 35 d
  129600, // 7  Fluent  → 90 d
]

const MIN = 60_000

export function intervalForLevel(level: number): number {
  const l = Math.max(0, Math.min(FLUENT_LEVEL, level))
  return LEVEL_INTERVALS_MIN[l] * MIN
}

export function formatInterval(ms: number): string {
  const min = ms / MIN
  if (min < 60) return `${Math.round(min)}分`
  const h = min / 60
  if (h < 24) return `${Math.round(h)}時間`
  const d = h / 24
  if (d < 30) return d % 1 === 0 ? `${d}日` : `${d.toFixed(1)}日`
  const mo = d / 30
  if (mo < 12) return `${Math.round(mo)}か月`
  return `${(mo / 12).toFixed(1)}年`
}

export function formatDue(due: number, now: number): string {
  const diff = due - now
  if (diff <= 0) return '今すぐ'
  return `${formatInterval(diff)}後`
}

/** Apply a grade, returning the next card state. */
export function gradeCard(card: Card, grade: Grade, now: number): Card {
  let level: number
  switch (grade) {
    case 'again':
      level = 0
      break
    case 'hard':
      level = card.level // stay put, short re-check
      break
    case 'good':
      level = Math.min(FLUENT_LEVEL, card.level + 1)
      break
    case 'easy':
      level = Math.min(FLUENT_LEVEL, card.level + 2)
      break
  }
  let interval = intervalForLevel(level)
  if (grade === 'hard') interval = intervalForLevel(Math.max(1, level)) / 2
  if (grade === 'easy') interval = interval * 1.3
  return {
    ...card,
    level,
    introduced: true,
    due: now + Math.round(interval),
    reviews: card.reviews + 1,
    lapses: card.lapses + (grade === 'again' ? 1 : 0),
  }
}

/** Preview of "when will I see this again" for each grade button. */
export function gradePreview(card: Card): Record<Grade, string> {
  const out = {} as Record<Grade, string>
  for (const g of ['again', 'hard', 'good', 'easy'] as Grade[]) {
    const next = gradeCard(card, g, 0)
    out[g] = formatInterval(next.due)
  }
  return out
}

/** Simple +/- scoring: right = +1 level, wrong = −1 level and back in 10 min. */
export function gradeSimple(card: Card, correct: boolean, now: number): Card {
  if (correct) {
    const level = Math.min(FLUENT_LEVEL, card.level + 1)
    return {
      ...card,
      level,
      introduced: true,
      due: now + intervalForLevel(level),
      reviews: card.reviews + 1,
    }
  }
  return {
    ...card,
    level: Math.max(0, card.level - 1),
    introduced: true,
    due: now + 10 * MIN,
    reviews: card.reviews + 1,
    lapses: card.lapses + 1,
  }
}

export function isDue(card: Card, now: number): boolean {
  return card.introduced && card.due <= now
}

export function dueCards(cards: Card[], now: number): Card[] {
  return cards
    .filter((c) => isDue(c, now))
    .sort((a, b) => a.due - b.due || a.createdAt - b.createdAt)
}

/** New (never introduced) cards, oldest first. */
export function newCards(cards: Card[]): Card[] {
  return cards.filter((c) => !c.introduced).sort((a, b) => a.createdAt - b.createdAt)
}

export function nextDue(cards: Card[], now: number): number | null {
  const future = cards.filter((c) => c.introduced && c.due > now).map((c) => c.due)
  return future.length ? Math.min(...future) : null
}

/** Overall fluency = average WORD mastery as a % of the ladder.
 *  Conjugations don't have their own mastery — they count toward their word. */
export function fluencyPercent(cards: Card[]): number {
  const groups = wordGroups(cards)
  if (!groups.size) return 0
  let sum = 0
  for (const g of groups.values()) sum += groupMastery(g)
  return Math.round((sum / (groups.size * FLUENT_LEVEL)) * 100)
}

/** The unit mastery is tracked on: the lemma (base) or the card itself. */
export function groupKey(c: Card): string {
  return c.base ?? c.front
}

/** Cards grouped by word: a verb lemma + all its conjugation cards = one group. */
export function wordGroups(cards: Card[]): Map<string, Card[]> {
  const m = new Map<string, Card[]>()
  for (const c of cards) {
    const k = groupKey(c)
    const g = m.get(k)
    if (g) g.push(c)
    else m.set(k, [c])
  }
  return m
}

/** Mastery level of a word (float 0..7): average level of its introduced
 *  cards — the lemma AND every conjugation of it counts together. */
export function groupMastery(group: Card[]): number {
  const intro = group.filter((c) => c.introduced)
  if (!intro.length) return 0
  return intro.reduce((s, c) => s + c.level, 0) / intro.length
}

// ─── Bulk import ───────────────────────────────────────────────────────────

/** Parse pasted lines like "speak — 話す" (also accepts - , ; or tab). */
export function parseBulk(text: string): Array<{ front: string; back: string }> {
  const out: Array<{ front: string; back: string }> = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    let m = line.split('\t')
    if (m.length < 2) m = line.split(/\s+[—–-]\s+/)
    if (m.length < 2) m = line.split(/\s*;\s*/)
    if (m.length < 2) m = line.split(/\s*,\s*/)
    if (m.length < 2) continue
    const front = m[0].trim()
    const back = m.slice(1).join(' ').trim()
    if (front && back) out.push({ front, back })
  }
  return out
}

// ─── Persistence ───────────────────────────────────────────────────────────

const KEY_PREFIX = 'speak-english:v1:'
const ANON_KEY = 'speak-english:v1'
const ACCOUNTS_KEY = 'speak-english:accounts'
const CURRENT_KEY = 'speak-english:current'
const LEGACY_KEYS: string[] = []

// ─── Accounts (local profiles — each keeps its own deck + progress) ────────

export interface Account {
  name: string
  createdAt: number
}

export function listAccounts(): Account[] {
  try {
    return JSON.parse(localStorage.getItem(ACCOUNTS_KEY) ?? '[]') as Account[]
  } catch {
    return []
  }
}

export function createAccount(name: string): Account {
  const account = { name: name.trim(), createdAt: Date.now() }
  const all = listAccounts().filter((a) => a.name !== account.name)
  all.push(account)
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(all))
  return account
}

export function deleteAccount(name: string) {
  localStorage.setItem(
    ACCOUNTS_KEY,
    JSON.stringify(listAccounts().filter((a) => a.name !== name)),
  )
  localStorage.removeItem(KEY_PREFIX + name)
  if (getCurrentAccount() === name) setCurrentAccount(null)
}

export function getCurrentAccount(): string | null {
  return localStorage.getItem(CURRENT_KEY)
}

export function setCurrentAccount(name: string | null) {
  if (name) localStorage.setItem(CURRENT_KEY, name)
  else localStorage.removeItem(CURRENT_KEY)
}

/** Wipe one account's deck + progress (fresh seed on next load). */
export function resetState(account: string) {
  localStorage.removeItem(KEY_PREFIX + account)
}

// ─── Guest demo: the same 20 words every time, nothing saved ───────────────

const DEMO_WORDS: Array<[string, string]> = [
  ['time', '時間、時'],
  ['people', '人々'],
  ['water', '水'],
  ['friend', '友達'],
  ['house', '家'],
  ['day', '日、一日'],
  ['night', '夜'],
  ['book', '本'],
  ['city', '市、都市'],
  ['work', '仕事、働く'],
  ['world', '世界'],
  ['life', '人生、生活'],
  ['good', '良い'],
  ['big', '大きい'],
  ['new', '新しい'],
  ['happy', '幸せな'],
  ['speak', '話す'],
  ['make', '作る'],
  ['want', '欲しい、したい'],
  ['know', '知る'],
]

export function demoState(): AppState {
  const now = Date.now()
  return {
    cards: DEMO_WORDS.map(([f, b], i) => ({
      id: `demo_${i}`,
      front: f,
      back: b,
      kind: 'word' as const,
      level: 0,
      due: now,
      introduced: false,
      createdAt: now - (DEMO_WORDS.length - i) * 1000,
      reviews: 0,
      lapses: 0,
    })),
    history: {},
    introLog: {},
    newPerDay: 20,
    grading: 'simple',
  }
}

export interface AppState {
  cards: Card[]
  /** date (YYYY-MM-DD) → number of reviews that day */
  history: Record<string, number>
  /** date (YYYY-MM-DD) → number of new cards introduced that day */
  introLog: Record<string, number>
  /** how many new cards enter circulation per day */
  newPerDay: number
  /** 'simple' = right +1 / wrong −1 · 'grades' = again/hard/good/easy */
  grading: 'simple' | 'grades'
}

export function todayKey(now = Date.now()): string {
  const d = new Date(now)
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export function streakDays(history: Record<string, number>, now = Date.now()): number {
  let streak = 0
  const d = new Date(now)
  // today may not have reviews yet — don't break the streak for that
  if (!history[todayKey(d.getTime())]) d.setDate(d.getDate() - 1)
  while (history[todayKey(d.getTime())]) {
    streak++
    d.setDate(d.getDate() - 1)
  }
  return streak
}

export function loadState(account: string): AppState {
  for (const k of LEGACY_KEYS) localStorage.removeItem(k)
  // one-time migration: anonymous pre-accounts state moves into the account
  const anon = localStorage.getItem(ANON_KEY)
  if (anon && !localStorage.getItem(KEY_PREFIX + account)) {
    localStorage.setItem(KEY_PREFIX + account, anon)
  }
  localStorage.removeItem(ANON_KEY)
  try {
    const raw = localStorage.getItem(KEY_PREFIX + account)
    if (raw) {
      const parsed = JSON.parse(raw) as AppState
      if (Array.isArray(parsed.cards)) {
        return {
          cards: parsed.cards,
          history: parsed.history ?? {},
          introLog: parsed.introLog ?? {},
          newPerDay: parsed.newPerDay ?? 20,
          grading: parsed.grading ?? 'simple',
        }
      }
    }
  } catch {
    /* corrupted storage → reseed */
  }
  const seeded: AppState = {
    cards: seedCards(),
    history: {},
    introLog: {},
    newPerDay: 20,
    grading: 'simple',
  }
  saveState(seeded, account)
  return seeded
}

export function saveState(state: AppState, account: string) {
  localStorage.setItem(KEY_PREFIX + account, JSON.stringify(state))
}

export function makeCard(partial: {
  front: string
  back: string
  kind: CardKind
  base?: string
  note?: string
}): Card {
  const now = Date.now()
  return {
    id: `c_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    front: partial.front.trim(),
    back: partial.back.trim(),
    kind: partial.kind,
    base: partial.base?.trim() || undefined,
    note: partial.note?.trim() || undefined,
    level: 0,
    due: now,
    introduced: false, // waits for the daily new-card quota
    createdAt: now,
    reviews: 0,
    lapses: 0,
  }
}

// ─── Seed deck: English for Japanese speakers, advanced-B2, ~8,600 cards ───
// 8,000 frequency-ordered word cards (OpenSubtitles frequency list + EJDict
// 英和辞典 glosses) + verb-form cards for the top ~180 verbs (3rd person,
// past, past participle, -ing), where every form is its own independent card.
// Conjugation groups are interleaved through the word list (one verb's
// paradigm every ~40 words) so forms show up while the verb is fresh.

function seedCards(): Card[] {
  type Row = { f: string; b: string; kind: CardKind; base?: string }
  const rows: Row[] = []

  // interleave one verb paradigm (4 forms) every 40 frequency words
  let ci = 0
  EN_WORDS.forEach((w, i) => {
    rows.push({ f: w.f, b: w.b, kind: 'word' })
    if ((i + 1) % 40 === 0 && ci < EN_CONJUGATIONS.length) {
      for (const c of EN_CONJUGATIONS.slice(ci, ci + 4)) {
        rows.push({ f: c.f, b: c.b, kind: 'conjugation', base: c.base })
      }
      ci += 4
    }
  })
  for (const c of EN_CONJUGATIONS.slice(ci)) {
    rows.push({ f: c.f, b: c.b, kind: 'conjugation', base: c.base })
  }

  const now = Date.now()
  return rows.map((r, i) => ({
    id: `seed_${i}`,
    front: r.f,
    back: r.b,
    kind: r.kind,
    base: r.base,
    level: 0,
    due: now,
    introduced: false,
    // earlier rows get introduced first
    createdAt: now - (rows.length - i) * 1000,
    reviews: 0,
    lapses: 0,
  }))
}

// ─── Verb paradigm lookup (for "add this verb's conjugations") ─────────────

let verbIndex: Map<string, VerbRow> | null = null

/** Look up a verb lemma (case-insensitive) in the paradigm table. */
export function findVerb(lemma: string): VerbRow | null {
  if (!verbIndex) verbIndex = new Map(EN_VERB_FORMS.map((r) => [r[0].toLowerCase(), r]))
  return verbIndex.get(lemma.trim().toLowerCase()) ?? null
}

const VERB_FORM_TAGS = [
  '三人称単数現在 (〜s)',
  '過去形',
  '過去分詞',
  '現在分詞 (〜ing)',
] as const

/** Turn a paradigm row into 4 conjugation card inputs (each its own card). */
export function verbConjugationCards(
  row: VerbRow,
): Array<{ front: string; back: string; kind: 'conjugation'; base: string }> {
  const [lemma, gloss, ...forms] = row
  return forms.map((f, i) => ({
    front: f,
    back: `${gloss} — ${VERB_FORM_TAGS[i]}`,
    kind: 'conjugation' as const,
    base: lemma,
  }))
}
