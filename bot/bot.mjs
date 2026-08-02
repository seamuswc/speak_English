// ─── SRS Fluency Telegram bot ──────────────────────────────────────────────
// Zero-dependency long-polling bot (Node 20+). Set TELEGRAM_BOT_TOKEN and run:
//   TELEGRAM_BOT_TOKEN=123:abc node bot/bot.mjs
import {
  FLUENT_LEVEL,
  LEVEL_NAMES,
  fluencyPercent,
  formatInterval,
  gradeSimple,
  intervalForLevel,
  loadUser,
  reviewQueue,
  saveUser,
  streakDays,
  todayKey,
  wordGroups,
  groupMastery,
} from './core.mjs'

const PREVIEW = process.argv.includes('--preview')
const TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!TOKEN && !PREVIEW) {
  console.error('Set TELEGRAM_BOT_TOKEN first (get one from @BotFather in Telegram).')
  process.exit(1)
}
const API = `https://api.telegram.org/bot${TOKEN}`

// swappable so --preview can intercept every outgoing call
let apiImpl = async (method, payload) => {
  const r = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const j = await r.json()
  if (!j.ok) console.error(`${method} failed:`, j.description)
  return j
}

const api = (method, payload) => apiImpl(method, payload)

const send = (chatId, text, extra = {}) =>
  api('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra })

// per-chat pending quiz: { cardId, messageId }
const pending = new Map()

function cardLabel(card) {
  const tag = card.kind === 'conjugation' ? `<i>${card.base}</i> の活用形` : '単語'
  const isNew = card.introduced ? '' : ' 🆕'
  return `${tag}${isNew}`
}

async function sendNextCard(chatId, s) {
  const queue = reviewQueue(s)
  if (!queue.length) {
    pending.delete(chatId)
    const next = s.cards.filter((c) => c.introduced && c.due > Date.now()).map((c) => c.due)
    const when = next.length ? ` 次の復習まで ${formatInterval(Math.min(...next) - Date.now())}。` : ''
    const backlog = s.cards.filter((c) => !c.introduced).length
    const bl = backlog ? ` あと ${backlog} 語が明日以降の新規枠で出ます。` : ''
    await send(chatId, `✅ <b>完了！ 全部終わりました。</b>${when}${bl}`)
    return
  }
  const card = queue[0]
  pending.set(chatId, { cardId: card.id })
  await send(chatId, `<b>${card.front}</b>\n\n<i>${cardLabel(card)} · 残り ${queue.length}</i>`, {
    reply_markup: { inline_keyboard: [[{ text: '👁 答えを見る', callback_data: 'reveal' }]] },
  })
}

async function handleMessage(msg) {
  const chatId = msg.chat.id
  const text = (msg.text ?? '').trim()
  const s = loadUser(chatId)

  if (text.startsWith('/start') || text.startsWith('/study')) {
    await send(
      chatId,
      `🇬🇧 <b>Speak English</b> — 英語をゼロからペラペラまで。\n` +
        `✓ 正解 (+1レベル) か ✗ 不正解 (−1レベル) で答えてね。活用形もその単語の習熟度にカウントされます。\n\n` +
        `/study — 復習する\n/stats — 進捗を見る\n/quota 30 — 1日の新規単語数\n/help — コマンド一覧`,
    )
    await sendNextCard(chatId, s)
    return
  }
  if (text.startsWith('/help')) {
    await send(
      chatId,
      `/study — 期日のカードを復習\n/stats — 流暢さ・連続日数・復習数\n/quota N — 1日の新規単語数を設定 (初期値 20)\n\nレベル: ${LEVEL_NAMES.map((n, i) => `L${i} ${n}`).join(' → ')}`,
    )
    return
  }
  if (text.startsWith('/stats')) {
    const groups = wordGroups(s.cards)
    const introduced = s.cards.filter((c) => c.introduced).length
    const due = reviewQueue(s).length
    let fluent = 0
    for (const g of groups.values()) if (groupMastery(g) >= FLUENT_LEVEL) fluent++
    await send(
      chatId,
      `📊 <b>あなたの進捗</b>\n` +
        `流暢さ: <b>${fluencyPercent(s.cards)}%</b> (単語の習熟度)\n` +
        `単語: ${groups.size} · うち流暢 ${fluent}\n` +
        `学習中のカード: ${introduced}/${s.cards.length}\n` +
        `今すぐ復習: ${due}\n` +
        `今日の復習数: ${s.history[todayKey()] ?? 0}\n` +
        `連続: 🔥 ${streakDays(s.history)}日\n` +
        `1日の新規枠: ${s.newPerDay}`,
    )
    return
  }
  if (text.startsWith('/quota')) {
    const n = parseInt(text.split(/\s+/)[1] ?? '', 10)
    if (!n || n < 1 || n > 200) {
      await send(chatId, '使い方: /quota 30 (1日の新規単語 1–200)')
    } else {
      s.newPerDay = n
      saveUser(chatId, s)
      await send(chatId, `✓ 1日の新規単語を ${n} に設定しました。`)
    }
    return
  }
  // any other text during a quiz = treat as a nudge to reveal
  if (pending.has(chatId)) {
    await send(chatId, '👁 答えを見る をタップして、✓ / ✗ で自己評価してね。')
  } else {
    await send(chatId, '/study で復習、/stats で進捗が見られます。')
  }
}

async function handleCallback(cb) {
  const chatId = cb.message.chat.id
  const messageId = cb.message.message_id
  const s = loadUser(chatId)
  const p = pending.get(chatId)

  if (!p) {
    await api('answerCallbackQuery', { callback_query_id: cb.id, text: '採点するものがありません — /study' })
    return
  }
  const card = s.cards.find((c) => c.id === p.cardId)
  if (!card) {
    pending.delete(chatId)
    await api('answerCallbackQuery', { callback_query_id: cb.id })
    return
  }

  if (cb.data === 'reveal') {
    await api('answerCallbackQuery', { callback_query_id: cb.id })
    await api('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: `<b>${card.front}</b>\n\n${card.back}\n\n<i>${cardLabel(card)} · L${card.level} ${LEVEL_NAMES[card.level]}</i>`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✗ 不正解 (−1)', callback_data: 'wrong' },
            { text: '✓ 正解 (+1)', callback_data: 'right' },
          ],
        ],
      },
    })
    return
  }

  if (cb.data === 'right' || cb.data === 'wrong') {
    const now = Date.now()
    const correct = cb.data === 'right'
    const next = gradeSimple(card, correct, now)
    const key = todayKey(now)
    s.cards = s.cards.map((c) => (c.id === card.id ? next : c))
    s.history[key] = (s.history[key] ?? 0) + 1
    if (!card.introduced) s.introLog[key] = (s.introLog[key] ?? 0) + 1
    saveUser(chatId, s)
    pending.delete(chatId)

    const delta = correct ? `+1 → L${next.level} ${LEVEL_NAMES[next.level]}` : `−1 → L${next.level} ${LEVEL_NAMES[next.level]}`
    await api('answerCallbackQuery', {
      callback_query_id: cb.id,
      text: `${correct ? '✓' : '✗'} ${delta} · 次は ${formatInterval(next.due - now)}後`,
    })
    await api('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: `<b>${card.front}</b> — ${card.back}\n\n${correct ? '✓' : '✗'} <i>${delta}、次は ${formatInterval(next.due - now)}後</i>`,
      parse_mode: 'HTML',
    })
    await sendNextCard(chatId, s)
  }
}

// ─── long polling loop ──────────────────────────────────────────────────────

let offset = 0
async function poll() {
  try {
    const j = await api('getUpdates', { offset, timeout: 30 })
    for (const u of j.result ?? []) {
      offset = u.update_id + 1
      try {
        if (u.message) await handleMessage(u.message)
        else if (u.callback_query) await handleCallback(u.callback_query)
      } catch (e) {
        console.error('update failed:', e)
      }
    }
  } catch (e) {
    console.error('poll error:', e.message ?? e)
    await new Promise((r) => setTimeout(r, 3000))
  }
  setImmediate(poll)
}

// ─── offline preview: simulate a Telegram conversation in the terminal ─────

function stripHtml(html) {
  return html.replace(/<\/?b>/g, '*').replace(/<\/?i>/g, '_').replace(/<[^>]+>/g, '')
}

function printKeyboard(rm) {
  for (const row of rm?.inline_keyboard ?? []) {
    console.log('   ┌ ' + row.map((b) => `[ ${b.text} ]`).join(' '))
  }
}

async function runPreview() {
  const chatId = 'preview_user'
  apiImpl = async (method, payload) => {
    if (method === 'sendMessage' || method === 'editMessageText') {
      const tag = method === 'editMessageText' ? ' (message updated)' : ''
      console.log(`\n🤖 BOT${tag}: ${stripHtml(payload.text)}`)
      printKeyboard(payload.reply_markup)
    } else if (method === 'answerCallbackQuery' && payload.text) {
      console.log(`   🔔 toast: ${payload.text}`)
    }
    return { ok: true, result: [] }
  }
  const user = (text) => {
    console.log(`\n👤 YOU: ${text}`)
    return handleMessage({ chat: { id: chatId }, text })
  }
  const tap = (data) => {
    console.log(`\n👤 YOU tap: ${data}`)
    return handleCallback({ id: 'cb', data, message: { chat: { id: chatId }, message_id: 1 } })
  }

  await user('/start')
  await tap('reveal')
  await tap('right')
  await tap('reveal')
  await tap('wrong')
  await user('/stats')
  console.log('')
}

if (PREVIEW) {
  runPreview()
} else {
  console.log('Speak English bot polling…')
  poll()
}
