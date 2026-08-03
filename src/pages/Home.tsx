import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  BarChart3,
  BookOpenText,
  Eye,
  Flame,
  GraduationCap,
  Import,
  Layers,
  Library as LibraryIcon,
  Loader2,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  UserRound,
  UserRoundPlus,
  Volume2,
} from 'lucide-react'
import {
  type AppState,
  type Card,
  type CardKind,
  FLUENT_LEVEL,
  type Grade,
  LEVEL_NAMES,
  demoState,
  dueCards,
  findVerb,
  fluencyPercent,
  formatDue,
  formatInterval,
  gradeCard,
  gradePreview,
  gradeSimple,
  groupMastery,
  intervalForLevel,
  loadState,
  makeCard,
  newCards,
  nextDue,
  parseBulk,
  resetState,
  saveState,
  streakDays,
  todayKey,
  verbConjugationCards,
  wordGroups,
} from '@/lib/srs'
import {
  apiForgot,
  apiGetState,
  apiLogin,
  apiLogout,
  apiPayCheck,
  apiPayRenew,
  apiPutState,
  apiRegister,
  apiReset,
  loadAuth,
  saveAuth,
  type Auth,
  type PaymentInfo,
} from '@/lib/api'
import QRCode from 'qrcode'

type Tab = 'review' | 'add' | 'library' | 'progress'

const LEVEL_COLORS = [
  'bg-stone-200 text-stone-700',
  'bg-red-100 text-red-700',
  'bg-orange-100 text-orange-700',
  'bg-amber-100 text-amber-700',
  'bg-yellow-100 text-yellow-800',
  'bg-lime-100 text-lime-800',
  'bg-green-100 text-green-800',
  'bg-emerald-600 text-white',
]

const KIND_STYLES: Record<CardKind, string> = {
  word: 'bg-sky-100 text-sky-800 border-sky-200',
  conjugation: 'bg-violet-100 text-violet-800 border-violet-200',
}

const KIND_LABELS: Record<CardKind, string> = {
  word: '単語',
  conjugation: '活用形',
}

function LevelPill({ level }: { level: number }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${LEVEL_COLORS[level]}`}
    >
      L{level} · {LEVEL_NAMES[level]}
    </span>
  )
}

export default function Home() {
  const [auth, setAuth] = useState<Auth | null>(() => loadAuth())
  const [showAuth, setShowAuth] = useState(false)
  const [resetToken, setResetToken] = useState<string | null>(() =>
    window.location.hash.startsWith('#reset=') ? window.location.hash.slice(7) : null,
  )

  if (resetToken) {
    return (
      <ResetScreen
        token={resetToken}
        onDone={() => {
          history.replaceState(null, '', window.location.pathname)
          setResetToken(null)
          setShowAuth(true)
        }}
      />
    )
  }

  if (showAuth) {
    return (
      <AuthScreen
        auth={auth}
        onAuth={(a) => {
          saveAuth(a)
          setAuth(a)
          setShowAuth(false)
        }}
        onLogout={() => {
          if (auth) apiLogout(auth.token)
          saveAuth(null)
          setAuth(null)
        }}
        onBack={() => setShowAuth(false)}
      />
    )
  }

  // signed in but subscription expired → paywall (renewal)
  if (auth && auth.subUntil !== undefined && auth.subUntil <= Date.now()) {
    return (
      <PayScreen
        email={auth.email}
        token={auth.token}
        initialPayment={null}
        onPaid={(a) => {
          saveAuth(a)
          setAuth(a)
        }}
        onCancel={() => {
          if (auth) apiLogout(auth.token)
          saveAuth(null)
          setAuth(null)
        }}
      />
    )
  }

  // signed-out visitors get demo mode (20 fixed words, unsaved);
  // signing in unlocks the full deck with server-synced progress
  return (
    <StudyApp
      key={auth ? auth.email : 'demo'} // remount when the account changes
      account={auth ? auth.email : 'Demo'}
      displayAccount={auth?.email ?? null}
      demo={!auth}
      auth={auth}
      onOpenAccounts={() => setShowAuth(true)}
    />
  )
}

function StudyApp({
  account,
  displayAccount,
  demo = false,
  auth,
  onOpenAccounts,
}: {
  account: string
  displayAccount: string | null
  demo?: boolean
  auth: Auth | null
  onOpenAccounts: () => void
}) {
  const [state, setState] = useState<AppState>(() => (demo ? demoState() : loadState(account)))
  const [tab, setTab] = useState<Tab>('review')
  const [now, setNow] = useState(() => Date.now())
  const [sessionCount, setSessionCount] = useState(0)

  useEffect(() => {
    if (!demo) saveState(state, account) // demo progress is never saved locally
  }, [state, account, demo])

  // pull progress from the server once on sign-in (server wins; if the server
  // has nothing yet, push the local state up)
  const syncedRef = useRef(false)
  useEffect(() => {
    if (!auth || syncedRef.current) return
    syncedRef.current = true
    apiGetState(auth.token)
      .then((remote) => {
        if (remote && Array.isArray(remote.cards) && remote.cards.length) {
          setState(remote)
        } else {
          apiPutState(auth.token, loadState(account)).catch(() => {})
        }
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // push progress to the server (debounced)
  useEffect(() => {
    if (!auth) return
    const t = setTimeout(() => apiPutState(auth.token, state).catch(() => {}), 1500)
    return () => clearTimeout(t)
  }, [state, auth])
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(t)
  }, [])

  const due = useMemo(() => dueCards(state.cards, now), [state.cards, now])
  const fresh = useMemo(() => newCards(state.cards), [state.cards])
  const introducedToday = state.introLog[todayKey(now)] ?? 0
  const quotaLeft = Math.max(0, state.newPerDay - introducedToday)
  const todaysNew = useMemo(() => fresh.slice(0, quotaLeft), [fresh, quotaLeft])
  const queue = useMemo(() => [...due, ...todaysNew], [due, todaysNew])

  const streak = useMemo(() => streakDays(state.history, now), [state.history, now])
  const reviewsToday = state.history[todayKey(now)] ?? 0

  const lastActionRef = useRef<{ prev: Card; key: string; wasNew: boolean } | null>(null)

  const applyResult = useCallback((card: Card, next: Card, t: number) => {
    const key = todayKey(t)
    lastActionRef.current = { prev: card, key, wasNew: !card.introduced }
    setState((s) => ({
      ...s,
      cards: s.cards.map((c) => (c.id === card.id ? next : c)),
      history: { ...s.history, [key]: (s.history[key] ?? 0) + 1 },
      introLog: card.introduced
        ? s.introLog
        : { ...s.introLog, [key]: (s.introLog[key] ?? 0) + 1 },
    }))
    setSessionCount((n) => n + 1)
  }, [])

  /** Backspace: reverse the last grade and bring the card back. */
  const undo = useCallback(() => {
    const last = lastActionRef.current
    if (!last) return
    lastActionRef.current = null
    setState((s) => ({
      ...s,
      cards: s.cards.map((c) => (c.id === last.prev.id ? last.prev : c)),
      history: { ...s.history, [last.key]: Math.max(0, (s.history[last.key] ?? 1) - 1) },
      introLog: last.wasNew
        ? { ...s.introLog, [last.key]: Math.max(0, (s.introLog[last.key] ?? 1) - 1) }
        : s.introLog,
    }))
    setSessionCount((n) => Math.max(0, n - 1))
  }, [])

  const grade = useCallback(
    (card: Card, g: Grade) => {
      const t = Date.now()
      setNow(t)
      applyResult(card, gradeCard(card, g, t), t)
    },
    [applyResult],
  )

  const gradeBinary = useCallback(
    (card: Card, correct: boolean) => {
      const t = Date.now()
      setNow(t)
      applyResult(card, gradeSimple(card, correct, t), t)
    },
    [applyResult],
  )

  const addCards = useCallback(
    (
      inputs: Array<{ front: string; back: string; kind: CardKind; base?: string; note?: string }>,
    ) => {
      setState((s) => {
        const existing = new Set(s.cards.map((c) => `${c.front}|${c.kind}`))
        const fresh = inputs.filter((i) => !existing.has(`${i.front.trim()}|${i.kind}`))
        return { ...s, cards: [...s.cards, ...fresh.map(makeCard)] }
      })
    },
    [],
  )

  const deleteCard = useCallback((id: string) => {
    setState((s) => ({ ...s, cards: s.cards.filter((c) => c.id !== id) }))
  }, [])

  const setNewPerDay = useCallback((n: number) => {
    setState((s) => ({ ...s, newPerDay: n }))
  }, [])

  const setGrading = useCallback((grading: 'simple' | 'grades') => {
    setState((s) => ({ ...s, grading }))
  }, [])

  const resetAll = useCallback(() => {
    if (demo) {
      setState(demoState())
    } else {
      resetState(account)
      setState(loadState(account))
    }
    setSessionCount(0)
  }, [account, demo])

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900">
      <header className="sticky top-0 z-10 border-b border-stone-200 bg-stone-50/90 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <GraduationCap className="h-6 w-6 text-emerald-700" />
            <h1 className="text-lg font-semibold tracking-tight">Speak English</h1>
            <span className="hidden text-xs text-stone-500 sm:inline">
              英語 · 0 → 流暢
            </span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="flex items-center gap-1 text-orange-600" title="連続学習日数">
              <Flame className="h-4 w-4" /> {streak}
            </span>
            <Badge variant={queue.length ? 'default' : 'secondary'} className="tabular-nums">
              あと {queue.length} 枚
            </Badge>
            {displayAccount ? (
              <button
                onClick={onOpenAccounts}
                className="flex items-center gap-1 rounded-full border border-stone-200 bg-white px-2 py-0.5 text-xs text-stone-600 hover:border-emerald-400 hover:text-emerald-700"
                title="アカウント"
              >
                <UserRound className="h-3.5 w-3.5" /> {displayAccount}
              </button>
            ) : (
              <button
                onClick={onOpenAccounts}
                className="flex items-center gap-1 rounded-full bg-emerald-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-800"
                title="ログイン / アカウント作成"
              >
                <UserRoundPlus className="h-3.5 w-3.5" /> ログイン
              </button>
            )}
          </div>
        </div>
        <nav className="mx-auto flex max-w-3xl gap-1 px-4 pb-2">
          {(
            [
              ['review', BookOpenText, '復習'],
              ['add', Plus, '追加'],
              ['library', LibraryIcon, '単語帳'],
              ['progress', BarChart3, '進捗'],
            ] as const
          ).map(([key, Icon, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                tab === key
                  ? 'bg-emerald-700 text-white'
                  : 'text-stone-600 hover:bg-stone-200'
              }`}
            >
              <Icon className="h-4 w-4" /> {label}
              {key === 'review' && queue.length > 0 && (
                <span
                  className={`ml-1 rounded-full px-1.5 text-xs tabular-nums ${
                    tab === key ? 'bg-white/25' : 'bg-emerald-100 text-emerald-800'
                  }`}
                >
                  {queue.length}
                </span>
              )}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-6">
        {demo && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
            <span>
              <strong>デモモード</strong> — 全員同じ20語。進捗は保存されません。
            </span>
            <Button size="sm" variant="outline" onClick={onOpenAccounts} className="shrink-0">
              アカウント作成
            </Button>
          </div>
        )}
        {tab === 'review' && (
          <ReviewView
            queue={queue}
            dueCount={due.length}
            freshBacklog={fresh.length}
            quotaLeft={quotaLeft}
            newPerDay={state.newPerDay}
            cards={state.cards}
            now={now}
            sessionCount={sessionCount}
            reviewsToday={reviewsToday}
            onGrade={grade}
            onSimple={gradeBinary}
            onUndo={undo}
            grading={state.grading}
            onToggleGrading={setGrading}
            goAdd={() => setTab('add')}
          />
        )}
        {tab === 'add' && <AddView onAdd={addCards} />}
        {tab === 'library' && (
          <LibraryView cards={state.cards} now={now} onDelete={deleteCard} />
        )}
        {tab === 'progress' && (
          <ProgressView
            state={state}
            now={now}
            streak={streak}
            reviewsToday={reviewsToday}
            introducedToday={introducedToday}
            onSetNewPerDay={setNewPerDay}
            onReset={resetAll}
          />
        )}
      </main>
    </div>
  )
}

// ─── Review ─────────────────────────────────────────────────────────────────

function ReviewView({
  queue,
  dueCount,
  freshBacklog,
  quotaLeft,
  newPerDay,
  cards,
  now,
  sessionCount,
  reviewsToday,
  onGrade,
  onSimple,
  onUndo,
  grading,
  onToggleGrading,
  goAdd,
}: {
  queue: Card[]
  dueCount: number
  freshBacklog: number
  quotaLeft: number
  newPerDay: number
  cards: Card[]
  now: number
  sessionCount: number
  reviewsToday: number
  onGrade: (card: Card, g: Grade) => void
  onSimple: (card: Card, correct: boolean) => void
  onUndo: () => void
  grading: 'simple' | 'grades'
  onToggleGrading: (m: 'simple' | 'grades') => void
  goAdd: () => void
}) {
  const [revealed, setRevealed] = useState(false)
  const card = queue[0]
  const isNew = card ? !card.introduced : false

  useEffect(() => setRevealed(false), [card?.id])

  const pick = useCallback(
    (g: Grade) => {
      if (!card || !revealed) return
      onGrade(card, g)
      setRevealed(false)
    },
    [card, revealed, onGrade],
  )

  const pickSimple = useCallback(
    (correct: boolean) => {
      if (!card || !revealed) return
      onSimple(card, correct)
      setRevealed(false)
    },
    [card, revealed, onSimple],
  )

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioTextRef = useRef('')
  const [audioLoading, setAudioLoading] = useState(false)

  // preload the current card's audio in the background as soon as the card
  // appears — reveal is instant when it finishes in time, and grading never
  // waits for it (any key skips ahead freely)
  useEffect(() => {
    if (!card) return
    const text = card.front
    audioTextRef.current = text
    setAudioLoading(true)
    const a = new Audio()
    audioRef.current = a
    const done = () => setAudioLoading(false)
    a.addEventListener('canplay', done)
    a.addEventListener('error', done)
    a.src = `/api/tts?text=${encodeURIComponent(text)}`
    a.load()
    return () => {
      a.pause()
      a.removeAttribute('src') // aborts the in-flight download
    }
  }, [card?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const playAudio = useCallback((text: string) => {
    const a = audioRef.current
    if (a && audioTextRef.current === text) {
      // already preloaded (or still loading — play() fires once buffered)
      a.currentTime = 0
      a.play().catch(() => {})
      return
    }
    const fresh = new Audio(`/api/tts?text=${encodeURIComponent(text)}`)
    audioRef.current = fresh
    audioTextRef.current = text
    fresh.play().catch(() => {})
  }, [])

  // reveal + auto-play pronunciation (called from click/key handlers so the
  // browser counts it as a user gesture and allows audio)
  const reveal = useCallback(() => {
    if (revealed || !card) return
    setRevealed(true)
    playAudio(card.front)
  }, [revealed, card, playAudio])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (!card) return
      const k = e.key.toLowerCase()

      // backspace → undo last grade, card comes back
      if (e.key === 'Backspace') {
        e.preventDefault()
        onUndo()
        return
      }

      // f / h / p → replay pronunciation
      if (k === 'f' || k === 'h' || k === 'p') {
        e.preventDefault()
        playAudio(card.front)
        return
      }

      // hidden card: space (or enter) reveals; other keys do nothing yet
      if (!revealed) {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault()
          reveal()
        }
        return
      }

      if (grading === 'simple') {
        // revealed: space or → = correct, any other key = wrong
        if (['Shift', 'Control', 'Alt', 'Meta', 'Tab', 'Escape', 'CapsLock'].includes(e.key)) return
        if (e.key.startsWith('F') && e.key.length > 1) return // F1–F12
        e.preventDefault()
        if (e.key === ' ' || e.key === 'ArrowRight') pickSimple(true)
        else pickSimple(false)
      } else {
        if (e.key === '1') pick('again')
        if (e.key === '2') pick('hard')
        if (e.key === '3' || e.key === ' ' || e.key === 'ArrowRight') {
          e.preventDefault()
          pick('good')
        }
        if (e.key === '4') pick('easy')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [card, revealed, pick, pickSimple, grading, reveal, playAudio, onUndo])

  if (!card) {
    const next = nextDue(cards, now)
    return (
      <div className="flex flex-col items-center gap-4 py-20 text-center">
        <Sparkles className="h-10 w-10 text-emerald-600" />
        <h2 className="text-2xl font-semibold">完了！全部終わりました</h2>
        <p className="max-w-sm text-stone-500">
          今は学習するものがありません。
          {next ? ` 次の復習は ${formatDue(next, now)}。` : ''}
          {freshBacklog > 0 &&
            ` 新規カードがあと ${freshBacklog} 枚あります — 今日の新規枠 ${newPerDay} 枚は使い切りました。`}
        </p>
        {sessionCount > 0 && (
          <p className="text-sm text-emerald-700">
            このセッションで {sessionCount} 枚 · 今日 {reviewsToday} 枚
          </p>
        )}
        <Button variant="outline" onClick={goAdd}>
          <Plus className="mr-1 h-4 w-4" /> カードを追加
        </Button>
      </div>
    )
  }

  const preview = gradePreview(card)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between text-sm text-stone-500">
        <span>
          復習 {dueCount} 枚
          {queue.length - dueCount > 0 && ` + 新規 ${queue.length - dueCount} 枚`}
          {freshBacklog > 0 && (
            <span className="text-stone-400">
              {' '}
              · 未導入 {freshBacklog} 枚 (今日の新規残り {quotaLeft} 枚)
            </span>
          )}
        </span>
        <span className="flex items-center gap-3 tabular-nums">
          <button
            onClick={() => onToggleGrading(grading === 'simple' ? 'grades' : 'simple')}
            className="rounded-full border border-stone-200 bg-white px-2 py-0.5 text-xs text-stone-500 hover:border-emerald-400 hover:text-emerald-700"
            title="採点方式を切り替え"
          >
            {grading === 'simple' ? '+/− 採点' : '4段階採点'}
          </button>
          <span className="hidden text-xs text-stone-300 sm:inline" title="直前の採点を取り消し">
            ⌫ やり直し
          </span>
          このセッション {sessionCount} 枚 · 今日 {reviewsToday} 枚
        </span>
      </div>

      <div className="rounded-2xl border border-stone-200 bg-white shadow-sm">
        <div className="flex items-center gap-2 border-b border-stone-100 px-6 pt-4 pb-3">
          <span
            className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${KIND_STYLES[card.kind]}`}
          >
            {KIND_LABELS[card.kind]}
          </span>
          {isNew && (
            <span className="rounded-full bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white">
              新規
            </span>
          )}
          {card.base && (
            <span className="flex items-center gap-1 text-xs text-stone-500">
              <Layers className="h-3 w-3" /> <em className="font-medium">{card.base}</em> の活用
            </span>
          )}
          <span className="ml-auto flex items-center gap-2">
            <button
              onClick={() => playAudio(card.front)}
              className="rounded-full p-1.5 text-stone-400 transition-colors hover:bg-emerald-50 hover:text-emerald-700"
              title={audioLoading ? '音声を読み込み中…' : '発音を聞く'}
            >
              {audioLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Volume2 className="h-4 w-4" />
              )}
            </button>
            <LevelPill level={card.level} />
          </span>
        </div>

        <button
          onClick={() => reveal()}
          className="block w-full cursor-pointer px-6 py-12 text-center"
        >
          <div className="text-4xl font-semibold tracking-tight">{card.front}</div>
          {revealed ? (
            <div className="mt-6">
              <div className="text-xl text-stone-600">{card.back}</div>
              {card.note && <div className="mt-2 text-sm text-stone-400">{card.note}</div>}
            </div>
          ) : (
            <div className="mt-6 flex items-center justify-center gap-1 text-sm text-stone-400">
              <Eye className="h-4 w-4" /> タップかスペースで答えを表示 · f/h/p で音声
            </div>
          )}
        </button>

        {grading === 'simple' ? (
          <div className="grid grid-cols-2 gap-2 border-t border-stone-100 p-4">
            <button
              disabled={!revealed}
              onClick={() => pickSimple(false)}
              className="flex flex-col items-center rounded-lg border border-red-200 bg-red-50 px-2 py-3 text-sm font-medium text-red-700 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span className="text-base">✗ 不正解</span>
              <span className="mt-0.5 text-xs font-normal opacity-70">
                −1 レベル · 10分後に再出題
              </span>
              <kbd className="mt-1 hidden rounded bg-white/60 px-1 text-[10px] text-stone-400 sm:inline">
                任意のキー
              </kbd>
            </button>
            <button
              disabled={!revealed}
              onClick={() => pickSimple(true)}
              className="flex flex-col items-center rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-3 text-sm font-medium text-emerald-700 transition-colors hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span className="text-base">✓ 正解</span>
              <span className="mt-0.5 text-xs font-normal opacity-70 tabular-nums">
                +1 レベル · 次は{' '}
                {formatInterval(intervalForLevel(Math.min(FLUENT_LEVEL, card.level + 1)))}後
              </span>
              <kbd className="mt-1 hidden rounded bg-white/60 px-1 text-[10px] text-stone-400 sm:inline">
                スペース / →
              </kbd>
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-2 border-t border-stone-100 p-4">
            {(
              [
                ['again', 'もう一度', '1', 'bg-red-50 text-red-700 hover:bg-red-100 border-red-200'],
                ['hard', '難しい', '2', 'bg-amber-50 text-amber-700 hover:bg-amber-100 border-amber-200'],
                ['good', '良い', '3', 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border-emerald-200'],
                ['easy', '簡単', '4', 'bg-sky-50 text-sky-700 hover:bg-sky-100 border-sky-200'],
              ] as const
            ).map(([g, label, key, cls]) => (
              <button
                key={g}
                disabled={!revealed}
                onClick={() => pick(g)}
                className={`flex flex-col items-center rounded-lg border px-2 py-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${cls}`}
              >
                <span>{label}</span>
                <span className="mt-0.5 text-xs font-normal opacity-70 tabular-nums">
                  {preview[g]}
                </span>
                <kbd className="mt-1 hidden rounded bg-white/60 px-1 text-[10px] text-stone-400 sm:inline">
                  {key}
                </kbd>
              </button>
            ))}
          </div>
        )}
      </div>

      {audioLoading && (
        <p className="flex items-center justify-center gap-1.5 text-center text-xs text-stone-400">
          <Loader2 className="h-3 w-3 animate-spin" /> 音声を読み込み中… そのまま進められます
        </p>
      )}

      {card.kind === 'conjugation' && card.base && (
        <p className="text-center text-xs text-stone-400">
          このカードは独自のスケジュールで復習されますが、習熟度は{' '}
          <em>{card.base}</em>{' '}
          にカウントされます:{' '}
          <span className="font-medium text-emerald-700">
            単語の習熟度 L
            {groupMastery(
              cards.filter((c) => (c.base ?? c.front) === card.base),
            ).toFixed(1)}
          </span>
        </p>
      )}
    </div>
  )
}

// ─── Add (single + bulk) ────────────────────────────────────────────────────

function AddView({
  onAdd,
}: {
  onAdd: (
    cards: Array<{ front: string; back: string; kind: CardKind; base?: string; note?: string }>,
  ) => void
}) {
  const [front, setFront] = useState('')
  const [back, setBack] = useState('')
  const [kind, setKind] = useState<CardKind>('word')
  const [base, setBase] = useState('')
  const [note, setNote] = useState('')
  const [flash, setFlash] = useState(false)

  const [bulkText, setBulkText] = useState('')
  const [bulkKind, setBulkKind] = useState<CardKind>('word')
  const [bulkBase, setBulkBase] = useState('')
  const [bulkFlash, setBulkFlash] = useState(0)
  const [paradigmFlash, setParadigmFlash] = useState('')

  const parsed = useMemo(() => parseBulk(bulkText), [bulkText])

  // paradigm lookup: front (any kind) or the conjugation's base word
  const verbHit = useMemo(() => {
    const probe = kind === 'conjugation' ? base : front
    return probe.trim() ? findVerb(probe) : null
  }, [front, base, kind])

  const addParadigm = () => {
    if (!verbHit) return
    onAdd(verbConjugationCards(verbHit))
    setParadigmFlash(verbHit[0])
    setTimeout(() => setParadigmFlash(''), 2500)
  }

  const submit = (keepBase: boolean) => {
    if (!front.trim() || !back.trim()) return
    onAdd([{ front, back, kind, base: kind === 'conjugation' ? base : undefined, note }])
    setFront('')
    setBack('')
    setNote('')
    if (!keepBase) setBase('')
    setFlash(true)
    setTimeout(() => setFlash(false), 1200)
  }

  const submitBulk = () => {
    if (!parsed.length) return
    onAdd(
      parsed.map((p) => ({
        ...p,
        kind: bulkKind,
        base: bulkKind === 'conjugation' ? bulkBase : undefined,
      })),
    )
    setBulkFlash(parsed.length)
    setBulkText('')
    setTimeout(() => setBulkFlash(0), 2500)
  }

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-8">
      <div>
        <h2 className="mb-1 text-xl font-semibold">カードを追加</h2>
        <p className="mb-5 text-sm text-stone-500">
          単語とその活用形は<strong>別々のカード</strong>として、独立した習熟レベルを持ちます。
          新しいカードは1日の新規枠に従って少しずつ復習に入ります。
        </p>

        <div className="flex flex-col gap-4 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
          <div className="grid gap-1.5">
            <Label htmlFor="kind">カードの種類</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as CardKind)}>
              <SelectTrigger id="kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="word">単語 (原形)</SelectItem>
                <SelectItem value="conjugation">活用形</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="front">表面 — 思い出す形</Label>
            <Input
              id="front"
              placeholder={kind === 'conjugation' ? '例: speaks' : '例: speak'}
              value={front}
              onChange={(e) => setFront(e.target.value)}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="back">裏面 — 意味 + 文法タグ</Label>
            <Input
              id="back"
              placeholder={
                kind === 'conjugation' ? '例: 話す — 三人称単数現在' : '例: 話す'
              }
              value={back}
              onChange={(e) => setBack(e.target.value)}
            />
          </div>

          {kind === 'conjugation' && (
            <div className="grid gap-1.5">
              <Label htmlFor="base">基本形 (原形)</Label>
              <Input
                id="base"
                placeholder="例: speak"
                value={base}
                onChange={(e) => setBase(e.target.value)}
              />
              <p className="text-xs text-stone-400">
                同じ基本形を持つ活用形は単語帳でグループ化されますが、レベルは別々に管理されます。
              </p>
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="note">メモ (任意)</Label>
            <Textarea
              id="note"
              rows={2}
              placeholder="覚え方、例文など…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          <div className="flex items-center gap-2 pt-1">
            <Button onClick={() => submit(false)} disabled={!front.trim() || !back.trim()}>
              <Plus className="mr-1 h-4 w-4" /> 追加
            </Button>
            {kind === 'conjugation' && (
              <Button
                variant="outline"
                onClick={() => submit(true)}
                disabled={!front.trim() || !back.trim()}
                title="基本形を保持したまま次の活用形を追加"
              >
                基本形を保持して追加
              </Button>
            )}
            {flash && <span className="text-sm text-emerald-600">追加しました ✓</span>}
          </div>

          {verbHit && (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-violet-200 bg-violet-50 px-4 py-3">
              <div className="text-sm">
                <span className="font-medium">{verbHit[0]}</span>{' '}
                <span className="text-stone-500">({verbHit[1]})</span> は動詞表にあります —
                4つの活用形カードを生成しますか?
              </div>
              <Button size="sm" variant="outline" onClick={addParadigm}>
                <Layers className="mr-1 h-3.5 w-3.5" /> +4 枚
              </Button>
            </div>
          )}
          {paradigmFlash && (
            <p className="text-sm text-emerald-600">
              {paradigmFlash} の活用形 4 枚を追加しました ✓ (重複はスキップ)
            </p>
          )}
        </div>
      </div>

      <div>
        <h2 className="mb-1 flex items-center gap-2 text-xl font-semibold">
          <Import className="h-5 w-5 text-emerald-700" /> 一括インポート
        </h2>
        <p className="mb-4 text-sm text-stone-500">
          流暢さには何千語も必要です — リストをまるごと貼り付けてください。1行1カード:
          <code className="mx-1 rounded bg-stone-100 px-1 text-xs">apple — リンゴ</code>
          (タブ、ダッシュ、セミコロン、カンマのどれでも区切れます)。
        </p>

        <div className="flex flex-col gap-4 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
          <Textarea
            rows={7}
            placeholder={'car — 車\ndog — 犬\nbeautiful — 美しい\n…'}
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
            className="font-mono text-sm"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Select value={bulkKind} onValueChange={(v) => setBulkKind(v as CardKind)}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="word">すべて単語</SelectItem>
                <SelectItem value="conjugation">すべて活用形</SelectItem>
              </SelectContent>
            </Select>
            {bulkKind === 'conjugation' && (
              <Input
                className="w-40"
                placeholder="基本形"
                value={bulkBase}
                onChange={(e) => setBulkBase(e.target.value)}
              />
            )}
            <Button onClick={submitBulk} disabled={!parsed.length} className="ml-auto">
              {parsed.length > 0 ? `${parsed.length} 枚を` : ''}インポート
            </Button>
          </div>
          {bulkFlash > 0 && (
            <p className="text-sm text-emerald-600">
              {bulkFlash} 枚インポートしました ✓ — 1日の新規枠に従って復習に入ります。
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Library ────────────────────────────────────────────────────────────────

function LibraryView({
  cards,
  now,
  onDelete,
}: {
  cards: Card[]
  now: number
  onDelete: (id: string) => void
}) {
  const [q, setQ] = useState('')
  const [kindFilter, setKindFilter] = useState<'all' | CardKind>('all')
  const [showAll, setShowAll] = useState(false)

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return cards
      .filter((c) => kindFilter === 'all' || c.kind === kindFilter)
      .filter(
        (c) =>
          !needle ||
          c.front.toLowerCase().includes(needle) ||
          c.back.toLowerCase().includes(needle) ||
          (c.base ?? '').toLowerCase().includes(needle),
      )
      .sort(
        (a, b) =>
          (a.base ?? a.front).localeCompare(b.base ?? b.front, 'en') ||
          a.front.localeCompare(b.front, 'en'),
      )
  }, [cards, q, kindFilter])

  const visible = showAll ? filtered : filtered.slice(0, 200)

  const counts = useMemo(() => {
    const m: Record<CardKind, number> = { word: 0, conjugation: 0 }
    for (const c of cards) m[c.kind]++
    return m
  }, [cards])

  const groups = useMemo(() => wordGroups(cards), [cards])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-stone-400" />
          <Input
            className="pl-8"
            placeholder="カードや基本形を検索…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <Select value={kindFilter} onValueChange={(v) => setKindFilter(v as typeof kindFilter)}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">すべて ({cards.length})</SelectItem>
            <SelectItem value="word">単語 ({counts.word})</SelectItem>
            <SelectItem value="conjugation">活用形 ({counts.conjugation})</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm">
        {visible.length === 0 ? (
          <p className="p-8 text-center text-sm text-stone-400">一致するカードがありません。</p>
        ) : (
          visible.map((c, i) => (
            <div
              key={c.id}
              className={`flex items-center gap-3 px-4 py-3 ${i > 0 ? 'border-t border-stone-100' : ''}`}
            >
              <span
                className={`w-24 shrink-0 rounded-full border px-2 py-0.5 text-center text-[11px] font-medium ${KIND_STYLES[c.kind]}`}
              >
                {KIND_LABELS[c.kind]}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">
                  {c.front}
                  {c.base && c.kind === 'conjugation' && (
                    <span className="ml-2 text-xs font-normal text-stone-400">← {c.base}</span>
                  )}
                </div>
                <div className="truncate text-sm text-stone-500">{c.back}</div>
              </div>
              <div className="hidden w-36 shrink-0 text-right sm:block">
                {(() => {
                  const group = groups.get(c.base ?? c.front)
                  const isGroupBase = c.kind === 'word' && group && group.length > 1
                  if (isGroupBase) {
                    const mastery = groupMastery(group)
                    const introducedForms = group.filter((g) => g.introduced).length
                    return (
                      <>
                        <LevelPill level={Math.round(mastery)} />
                        <div className="mt-0.5 text-[10px] text-stone-400">
                          単語の習熟度 · {introducedForms}/{group.length} 形
                        </div>
                      </>
                    )
                  }
                  return c.introduced ? (
                    <>
                      <LevelPill level={c.level} />
                      <div
                        className={`mt-0.5 text-[11px] tabular-nums ${c.due <= now ? 'text-emerald-600' : 'text-stone-400'}`}
                      >
                        {formatDue(c.due, now)}
                      </div>
                    </>
                  ) : (
                    <span className="text-[11px] text-stone-400">新規の待機中</span>
                  )
                })()}
              </div>
              <button
                onClick={() => onDelete(c.id)}
                className="shrink-0 rounded p-1.5 text-stone-300 transition-colors hover:bg-red-50 hover:text-red-500"
                title="カードを削除"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))
        )}
      </div>
      <div className="flex items-center justify-between text-xs text-stone-400">
        <span>
          {cards.length} 枚中 {filtered.length} 枚
          {!showAll && filtered.length > 200 && ' (最初の200件を表示)'}
        </span>
        {!showAll && filtered.length > 200 && (
          <button className="text-emerald-700 hover:underline" onClick={() => setShowAll(true)}>
            すべて表示
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Progress ───────────────────────────────────────────────────────────────

function ProgressView({
  state,
  now,
  streak,
  reviewsToday,
  introducedToday,
  onSetNewPerDay,
  onReset,
}: {
  state: AppState
  now: number
  streak: number
  reviewsToday: number
  introducedToday: number
  onSetNewPerDay: (n: number) => void
  onReset: () => void
}) {
  const { cards } = state
  const fluency = fluencyPercent(cards)
  const introduced = cards.filter((c) => c.introduced)
  const backlog = cards.length - introduced.length
  const dueNow = dueCards(cards, now).length

  const groups = useMemo(() => wordGroups(cards), [cards])
  const fluentWords = useMemo(() => {
    let n = 0
    for (const g of groups.values()) if (groupMastery(g) >= FLUENT_LEVEL) n++
    return n
  }, [groups])

  // distribution of WORD mastery (rounded) — conjugations roll up into their word
  const dist = useMemo(() => {
    const d = new Array(FLUENT_LEVEL + 1).fill(0) as number[]
    for (const g of groups.values()) {
      if (g.some((c) => c.introduced)) d[Math.round(groupMastery(g))]++
    }
    return d
  }, [groups])
  const maxDist = Math.max(1, ...dist)

  const days = useMemo(() => {
    const out: Array<{ label: string; count: number }> = []
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now)
      d.setDate(d.getDate() - i)
      out.push({
        label: `${d.getMonth() + 1}/${d.getDate()}`,
        count: state.history[todayKey(d.getTime())] ?? 0,
      })
    }
    return out
  }, [state.history, now])
  const maxDay = Math.max(1, ...days.map((d) => d.count))

  const stat = (label: string, value: string, sub?: string) => (
    <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
      <div className="text-xs uppercase tracking-wide text-stone-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-stone-500">{sub}</div>}
    </div>
  )

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="mb-1 flex items-end justify-between">
          <h2 className="text-xl font-semibold">流暢さへの道</h2>
          <span className="text-3xl font-bold text-emerald-700 tabular-nums">{fluency}%</span>
        </div>
        <Progress value={fluency} className="h-3" />
        <p className="mt-1 text-xs text-stone-400">
          {groups.size} 語の平均習熟度 — 活用形はすべてその単語にカウントされます。
          あと {backlog} 枚が新規の待機中です。
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stat('単語', `${groups.size}`, `流暢 ${fluentWords} 語`)}
        {stat('カード', `${cards.length}`, `学習中 ${introduced.length} 枚`)}
        {stat('今すぐ復習', `${dueNow}`, `今日 ${reviewsToday} 枚済み`)}
        {stat('連続', `${streak}日`)}
      </div>

      <div className="flex items-center justify-between rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
        <div>
          <div className="text-sm font-medium">1日の新規カード数</div>
          <div className="text-xs text-stone-500">
            今日は {state.newPerDay} 枚中 {introducedToday} 枚を導入済み ·
            何千語も一度には消化できません
          </div>
        </div>
        <Select
          value={`${state.newPerDay}`}
          onValueChange={(v) => onSetNewPerDay(parseInt(v, 10))}
        >
          <SelectTrigger className="w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[5, 10, 15, 20, 30, 50].map((n) => (
              <SelectItem key={n} value={`${n}`}>
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-sm font-medium">習熟レベル別の単語数</h3>
        <div className="flex flex-col gap-1.5">
          {dist.map((n, lvl) => (
            <div key={lvl} className="flex items-center gap-2 text-xs">
              <span className="w-20 shrink-0 text-stone-500">
                L{lvl} {LEVEL_NAMES[lvl]}
              </span>
              <div className="h-4 flex-1 overflow-hidden rounded bg-stone-100">
                <div
                  className={`h-full rounded ${lvl >= FLUENT_LEVEL ? 'bg-emerald-600' : 'bg-emerald-300'}`}
                  style={{ width: `${(n / maxDist) * 100}%` }}
                />
              </div>
              <span className="w-8 text-right tabular-nums text-stone-500">{n}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-sm font-medium">過去14日の復習数</h3>
        <div className="flex h-24 items-end gap-1">
          {days.map((d, i) => (
            <div key={i} className="flex flex-1 flex-col items-center gap-1">
              <div
                className="w-full rounded-t bg-emerald-400"
                style={{ height: `${Math.max(d.count ? 8 : 2, (d.count / maxDay) * 100)}%` }}
                title={`${d.label}: ${d.count} 枚`}
              />
              {i % 2 === 0 && (
                <span className="text-[9px] tabular-nums text-stone-400">{d.label}</span>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="flex justify-end">
        <Button variant="ghost" size="sm" className="text-stone-400" onClick={onReset}>
          <RotateCcw className="mr-1 h-3.5 w-3.5" /> データをリセット
        </Button>
      </div>
    </div>
  )
}


// ─── Auth screens (email + password, server-backed) ─────────────────────────

function AuthScreen({
  auth,
  onAuth,
  onLogout,
  onBack,
}: {
  auth: Auth | null
  onAuth: (a: Auth) => void
  onLogout: () => void
  onBack: () => void
}) {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [plan, setPlan] = useState<'month' | 'year'>('month')
  const [pendingPay, setPendingPay] = useState<{ email: string; payment: PaymentInfo } | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setError('')
    setNotice('')
    setBusy(true)
    try {
      if (mode === 'forgot') {
        await apiForgot(email)
        setNotice('そのメールアドレスにアカウントがあれば、再設定リンクを送信しました。受信トレイを確認してください。')
      } else if (mode === 'register') {
        const r = await apiRegister(email, password, plan)
        if ('paymentRequired' in r) {
          setPendingPay({ email: r.email, payment: r.payment })
        } else {
          onAuth(r)
        }
      } else {
        onAuth(await apiLogin(email, password))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'エラーが発生しました')
    } finally {
      setBusy(false)
    }
  }

  if (pendingPay) {
    return (
      <PayScreen
        email={pendingPay.email}
        token={null}
        initialPayment={pendingPay.payment}
        onPaid={onAuth}
        onCancel={() => setPendingPay(null)}
      />
    )
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-stone-50 px-4 text-stone-900">
      <div className="w-full max-w-md">
        <button onClick={onBack} className="mb-4 text-sm text-stone-500 hover:text-emerald-700">
          ← アプリに戻る
        </button>
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <GraduationCap className="h-10 w-10 text-emerald-700" />
          <h1 className="text-2xl font-semibold tracking-tight">Speak English</h1>
          <p className="text-sm text-stone-500">英語 · 0 → 流暢</p>
        </div>

        <div className="flex flex-col gap-4 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
          {auth ? (
            <>
              <div className="flex items-center gap-2 text-sm">
                <UserRound className="h-4 w-4 text-emerald-700" />
                <strong className="truncate">{auth.email}</strong> でログイン中
              </div>
              <p className="text-xs text-stone-500">
                進捗はサーバーに同期されます — どの端末からでも続きができます。
              </p>
              <Button variant="outline" onClick={onLogout}>
                ログアウト
              </Button>
            </>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-1 rounded-lg bg-stone-100 p-1 text-sm">
                {(
                  [
                    ['login', 'ログイン'],
                    ['register', '新規登録'],
                    ['forgot', '再設定'],
                  ] as const
                ).map(([m, label]) => (
                  <button
                    key={m}
                    onClick={() => {
                      setMode(m)
                      setError('')
                      setNotice('')
                    }}
                    className={`rounded-md px-2 py-1.5 font-medium transition-colors ${
                      mode === m ? 'bg-white shadow-sm' : 'text-stone-500 hover:text-stone-700'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="email">メールアドレス</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>

              {mode !== 'forgot' && (
                <div className="grid gap-1.5">
                  <Label htmlFor="password">パスワード</Label>
                  <Input
                    id="password"
                    type="password"
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    placeholder="6文字以上"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && submit()}
                  />
                </div>
              )}

              {mode === 'register' && (
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      ['month', '月額プラン', '$5 / 月', 'いつでもやめられる'],
                      ['year', '年間プラン', '$50 / 年', '2か月分お得'],
                    ] as const
                  ).map(([p, name, price, sub]) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPlan(p)}
                      className={`rounded-xl border p-3 text-left transition-colors ${
                        plan === p
                          ? 'border-emerald-500 bg-emerald-50 ring-1 ring-emerald-500'
                          : 'border-stone-200 bg-white hover:border-stone-300'
                      }`}
                    >
                      <div className="text-sm font-medium">{name}</div>
                      <div className="mt-0.5 text-lg font-semibold text-emerald-700">{price}</div>
                      <div className="text-[11px] text-stone-400">{sub}</div>
                    </button>
                  ))}
                  <p className="col-span-2 text-center text-[11px] text-stone-400">
                    お支払いは USDC または USDT (主要ネットワーク対応) · 登録後に送金画面が表示されます
                  </p>
                </div>
              )}

              {error && <p className="text-sm text-red-600">{error}</p>}
              {notice && <p className="text-sm text-emerald-700">{notice}</p>}

              <Button onClick={submit} disabled={busy || !email.trim() || (mode !== 'forgot' && !password)}>
                {busy
                  ? '…'
                  : mode === 'login'
                    ? 'ログイン'
                    : mode === 'register'
                      ? 'お支払いへ進む'
                      : '再設定リンクをメールで送る'}
              </Button>

              <p className="text-center text-xs text-stone-400">
                進捗はアカウントに同期され、どの端末でも続けられます。
                ログインしていない訪問者は20語のデモになります。
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── USDC payment screen (register paywall + renewal) ───────────────────────

function PayScreen({
  email,
  token,
  initialPayment,
  onPaid,
  onCancel,
}: {
  email: string
  /** null = fresh registration (no session yet) */
  token: string | null
  /** register path passes the intent directly; renewal fetches one */
  initialPayment: PaymentInfo | null
  onPaid: (a: Auth) => void
  onCancel: () => void
}) {
  const [payment, setPayment] = useState<PaymentInfo | null>(initialPayment)
  const [plan, setPlan] = useState<'month' | 'year'>(initialPayment?.plan ?? 'month')
  const [qr, setQr] = useState('')
  const [checking, setChecking] = useState(false)
  const [copied, setCopied] = useState('')
  const [error, setError] = useState('')
  const renewal = token !== null && initialPayment === null

  // renewal path: fetch an intent for the chosen plan
  useEffect(() => {
    if (!renewal) return
    setPayment(null)
    apiPayRenew(token, plan)
      .then((r) => setPayment(r.payment))
      .catch((e) => setError(e instanceof Error ? e.message : 'エラーが発生しました'))
  }, [renewal, token, plan])

  // QR for wallet apps (EIP-681 USDC transfer, pre-fills token + amount)
  useEffect(() => {
    if (!payment) return
    QRCode.toDataURL(payment.qr, {
      margin: 1,
      width: 200,
      color: { dark: '#1c1917', light: '#ffffff' },
    })
      .then(setQr)
      .catch(() => setQr(''))
  }, [payment])

  const check = useCallback(async () => {
    if (checking) return
    setChecking(true)
    setError('')
    try {
      const r = await apiPayCheck(token ? null : email, token)
      if (r.paid) {
        onPaid({ token: r.token ?? token!, email, subUntil: r.subUntil })
        return
      }
      if (r.expired) setError('この支払いリクエストは期限切れです。戻ってやり直してください。')
    } catch {
      // transient network/Etherscan hiccup — the next auto-check retries
    } finally {
      setChecking(false)
    }
  }, [checking, email, token, onPaid])

  // auto-check every 15 s
  useEffect(() => {
    if (!payment) return
    const t = setInterval(check, 15_000)
    return () => clearInterval(t)
  }, [payment, check])

  const copy = (text: string, what: string) => {
    navigator.clipboard?.writeText(text).catch(() => {})
    setCopied(what)
    setTimeout(() => setCopied(''), 1500)
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-stone-50 px-4 py-10 text-stone-900">
      <div className="w-full max-w-md">
        <button onClick={onCancel} className="mb-4 text-sm text-stone-500 hover:text-emerald-700">
          ← {renewal ? 'ログアウト' : '戻る'}
        </button>
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <GraduationCap className="h-10 w-10 text-emerald-700" />
          <h1 className="text-2xl font-semibold tracking-tight">
            {renewal ? 'サブスクリプションの更新' : 'お支払い'}
          </h1>
          <p className="text-sm text-stone-500">
            {renewal
              ? '有効期限が切れました。更新すると、保存された進捗にそのままアクセスできます。'
              : <>{email} · 残り1ステップです</>}
          </p>
        </div>

        <div className="flex flex-col gap-4 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
          {renewal && (
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ['month', '月額プラン', '$5 / 月'],
                  ['year', '年間プラン', '$50 / 年'],
                ] as const
              ).map(([p, name, price]) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPlan(p)}
                  className={`rounded-xl border p-3 text-left transition-colors ${
                    plan === p
                      ? 'border-emerald-500 bg-emerald-50 ring-1 ring-emerald-500'
                      : 'border-stone-200 bg-white hover:border-stone-300'
                  }`}
                >
                  <div className="text-sm font-medium">{name}</div>
                  <div className="mt-0.5 text-lg font-semibold text-emerald-700">{price}</div>
                </button>
              ))}
            </div>
          )}

          {payment ? (
            <>
              <div className="flex flex-col items-center gap-3 rounded-xl bg-stone-50 p-4">
                {qr && <img src={qr} alt="payment QR" className="h-40 w-40 rounded-lg" />}
                <div className="text-center">
                  <div className="text-xs uppercase tracking-wide text-stone-400">
                    送金額 (正確に)
                  </div>
                  <button
                    onClick={() => copy(payment.usdc, 'amount')}
                    className="mt-0.5 break-all font-mono text-lg font-semibold text-emerald-700 hover:underline"
                    title="タップでコピー"
                  >
                    {payment.usdc} USDC / USDT
                  </button>
                  <div className="text-xs text-stone-400">
                    ≈ ${payment.usd} · {copied === 'amount' ? 'コピーしました ✓' : 'タップでコピー'}
                  </div>
                </div>
              </div>

              <div className="grid gap-1.5">
                <div className="text-xs uppercase tracking-wide text-stone-400">送金先アドレス</div>
                <button
                  onClick={() => copy(payment.address, 'addr')}
                  className="break-all rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-left font-mono text-xs text-stone-700 hover:border-emerald-400"
                >
                  {payment.address}
                </button>
                <div className="text-right text-[11px] text-emerald-700">
                  {copied === 'addr' ? 'コピーしました ✓' : ''}
                </div>
              </div>

              <div className="flex items-center justify-center gap-2 text-sm text-stone-500">
                {checking ? (
                  <span className="animate-pulse">ブロックチェーンを確認中…</span>
                ) : (
                  <span>15秒ごとに自動確認します · 送金後そのままお待ちください</span>
                )}
              </div>
              <Button variant="outline" onClick={check} disabled={checking}>
                今すぐ確認
              </Button>
              <p className="text-center text-[11px] leading-relaxed text-stone-400">
                <strong>USDC または USDT</strong> · Ethereum / Arbitrum / Base / Optimism /
                Polygon / BSC のどのネットワークでも送れます。表示された金額を
                <strong>正確に</strong>送ってください (この金額で照合します)。QRはメインネットUSDC用 ·
                確認には通常1〜2分かかります。
              </p>
            </>
          ) : (
            <p className="py-8 text-center text-sm text-stone-400">
              {error || '支払い情報を生成しています…'}
            </p>
          )}
          {error && payment && <p className="text-center text-sm text-red-600">{error}</p>}
        </div>
      </div>
    </div>
  )
}

function ResetScreen({ token, onDone }: { token: string; onDone: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setError('')
    setBusy(true)
    try {
      await apiReset(token, password)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'エラーが発生しました')
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-stone-50 px-4 text-stone-900">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <GraduationCap className="h-10 w-10 text-emerald-700" />
          <h1 className="text-2xl font-semibold tracking-tight">新しいパスワードを設定</h1>
        </div>
        <div className="flex flex-col gap-4 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
          <div className="grid gap-1.5">
            <Label htmlFor="newpw">新しいパスワード</Label>
            <Input
              id="newpw"
              type="password"
              autoComplete="new-password"
              placeholder="6文字以上"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button onClick={submit} disabled={busy || password.length < 6}>
            {busy ? '…' : '新しいパスワードを設定'}
          </Button>
        </div>
      </div>
    </div>
  )
}
