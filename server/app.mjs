// Speak English server: static web app + auth API + progress sync + password recovery.
// Only dependency: stripe (payments). Passwords: scrypt. Sessions/reset: random tokens.
// Storage: server/data/auth.json + server/data/states/<hash>.json
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, extname, normalize, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import './env.mjs'
import { createReadStream } from 'node:fs'
import {
  PAYMENTS_ENABLED,
  PLANS,
  verifyCheckout,
  createCheckout,
  cancelSubscription,
  handleWebhook,
  subscriptionActive,
} from './pay.mjs'

const execFileAsync = promisify(execFile)

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', 'dist')
const DATA = join(HERE, 'data')
const STATES = join(DATA, 'states')
const AUTH_FILE = join(DATA, 'auth.json')
const TTS_DIR = join(DATA, 'tts')
const TTS_PYTHON = process.env.TTS_PYTHON ?? '/opt/speak-english/venv/bin/python'
const TTS_VOICE = process.env.TTS_VOICE ?? 'en-US-JennyNeural'
const PORT = parseInt(process.env.PORT ?? '80', 10)
const RESEND_API_KEY = process.env.RESEND_API_KEY ?? ''

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
}

// ─── auth store ─────────────────────────────────────────────────────────────

async function loadAuth() {
  try {
    return JSON.parse(await readFile(AUTH_FILE, 'utf8'))
  } catch {
    return { users: [], sessions: {}, resets: {} }
  }
}

async function saveAuth(a) {
  await mkdir(DATA, { recursive: true })
  await writeFile(AUTH_FILE, JSON.stringify(a))
}

const hashPassword = (password, salt) => scryptSync(password, salt, 64).toString('hex')
const token = () => randomBytes(32).toString('hex')
const stateFile = (email) => join(STATES, createHash('sha256').update(email.toLowerCase()).digest('hex') + '.json')

function sessionEmail(auth, req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')
  // fall back to ?token= — sendBeacon (tab-close flush) cannot set headers
  const t = m ? m[1] : new URL(req.url, 'http://x').searchParams.get('token')
  const s = t && auth.sessions[t]
  return s && s.exp > Date.now() ? s.email : null
}

function resetEmailHtml(link) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f4;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:480px;margin:0 auto;padding:40px 16px;">
    <div style="background:#ffffff;border:1px solid #e7e5e4;border-radius:16px;overflow:hidden;">
      <div style="background:#047857;padding:24px 32px;">
        <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:-0.3px;">🎓 Eigobot</span>
        <span style="color:#a7f3d0;font-size:13px;float:right;line-height:28px;">英語 · 0 → 流暢</span>
      </div>
      <div style="padding:32px;">
        <h1 style="margin:0 0 8px;font-size:22px;font-weight:600;color:#1c1917;">パスワードの再設定</h1>
        <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#57534e;">
          Eigobot アカウントのパスワード再設定リクエストを受け付けました。
          下のボタンから新しいパスワードを設定してください:
        </p>
        <div style="text-align:center;margin:0 0 24px;">
          <a href="${link}" style="display:inline-block;background:#047857;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 32px;border-radius:10px;">新しいパスワードを設定</a>
        </div>
        <p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#78716c;">
          このリンクの有効期限は <strong>1時間</strong> です。ボタンが動かない場合は、このURLをブラウザに貼り付けてください:
        </p>
        <p style="margin:0 0 16px;font-size:12px;line-height:1.5;word-break:break-all;color:#047857;background:#ecfdf5;border:1px solid #d1fae5;border-radius:8px;padding:10px 12px;">
          ${link}
        </p>
        <p style="margin:0;font-size:13px;line-height:1.6;color:#a8a29e;">
          心当たりがない場合は、このメールは無視して大丈夫です — パスワードは変更されません。
        </p>
      </div>
    </div>
    <p style="text-align:center;font-size:11px;color:#a8a29e;margin:16px 0 0;">
      Eigobot — 日本人のための英単語トレーナー
    </p>
  </div>
</body>
</html>`
}

async function sendResetEmail(email, link) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: 'Eigobot <noreply@support.eigobot.com>',
      to: [email],
      subject: 'パスワードの再設定 — Eigobot',
      html: resetEmailHtml(link),
      text: `Eigobot のパスワードを再設定します (リンクの有効期限は1時間):\n${link}\n\n心当たりがない場合は、このメールを無視してください。`,
    }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.message ?? `resend ${r.status}`)
}

// ─── API ────────────────────────────────────────────────────────────────────

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let b = ''
    req.on('data', (c) => {
      b += c
      if (b.length > 5_000_000) reject(new Error('too big'))
    })
    req.on('end', () => {
      try {
        resolve(b ? JSON.parse(b) : {})
      } catch {
        reject(new Error('bad json'))
      }
    })
  })

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// public origin for Stripe redirect URLs — behind an https reverse proxy in
// production (x-forwarded-proto), plain http for local development
function originOf(req) {
  const host = req.headers.host ?? 'localhost'
  const proto =
    req.headers['x-forwarded-proto'] ?? (/^(localhost|127\.)/.test(host) ? 'http' : 'https')
  return `${proto}://${host}`
}

async function handleApi(req, res, path) {
  const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : {}
  const auth = await loadAuth()

  if (path === '/api/register' && req.method === 'POST') {
    const email = (body.email ?? '').trim().toLowerCase()
    const password = body.password ?? ''
    if (!EMAIL_RE.test(email)) return json(res, 400, { error: 'メールアドレスが正しくありません' })
    if (password.length < 6) return json(res, 400, { error: 'パスワードは6文字以上にしてください' })
    if (auth.users.some((u) => u.email === email)) return json(res, 409, { error: 'このアカウントは既に存在します — ログインしてください' })
    const salt = randomBytes(16).toString('hex')
    // paid registration: no account row until the payment is confirmed —
    // credentials live in pendingRegs and are promoted by verifyCheckout
    if (PAYMENTS_ENABLED) {
      if (!auth.pendingRegs) auth.pendingRegs = {}
      auth.pendingRegs[email] = { email, salt, pass: hashPassword(password, salt), createdAt: Date.now() }
      const plan = body.plan === 'sub' ? 'sub' : 'month'
      // re-registering after paying but never completing the redirect (closed
      // tab, lost browser)? claim the already-paid session instead of
      // charging the customer twice
      const prior = Object.entries(auth.stripeSessions ?? {})
        .filter(([, s]) => s.email === email)
        .sort((a, b) => b[1].createdAt - a[1].createdAt)
        .slice(0, 3)
      for (const [sid] of prior) {
        try {
          const r = await verifyCheckout(auth, email, sid)
          if (r.paid) {
            const t = token()
            auth.sessions[t] = { email, exp: Date.now() + 90 * 24 * 3600 * 1000 }
            await saveAuth(auth)
            return json(res, 200, { token: t, email, subUntil: r.subUntil })
          }
        } catch {
          // session expired or unknown to Stripe — try the next one
        }
      }
      const payment = await createCheckout(auth, email, plan, originOf(req))
      await saveAuth(auth)
      return json(res, 200, { paymentRequired: true, payment, email })
    }
    auth.users.push({ email, salt, pass: hashPassword(password, salt), createdAt: Date.now(), subUntil: 0 })
    const t = token()
    auth.sessions[t] = { email, exp: Date.now() + 90 * 24 * 3600 * 1000 }
    await saveAuth(auth)
    return json(res, 200, { token: t, email })
  }

  if (path === '/api/login' && req.method === 'POST') {
    const email = (body.email ?? '').trim().toLowerCase()
    const u = auth.users.find((x) => x.email === email)
    const ok =
      u &&
      timingSafeEqual(
        Buffer.from(u.pass, 'hex'),
        Buffer.from(hashPassword(body.password ?? '', u.salt), 'hex'),
      )
    if (!ok) return json(res, 401, { error: 'メールアドレスかパスワードが違います' })
    const t = token()
    auth.sessions[t] = { email, exp: Date.now() + 90 * 24 * 3600 * 1000 }
    await saveAuth(auth)
    const out = { token: t, email }
    if (PAYMENTS_ENABLED) {
      out.subUntil = u.subUntil ?? 0
      out.autoRenew = Boolean(u.stripeSub)
    }
    return json(res, 200, out)
  }

  // payment status — verify Stripe Checkout session and activate subscription
  if (path === '/api/pay/check' && req.method === 'POST') {
    if (!PAYMENTS_ENABLED) return json(res, 400, { error: 'payments disabled' })
    const authed = sessionEmail(auth, req)
    const email = authed ?? (body.email ?? '').trim().toLowerCase()
    if (!email) return json(res, 400, { error: 'no email' })
    const sessionId = body.sessionId
    if (!sessionId) return json(res, 400, { error: 'no sessionId' })
    const r = await verifyCheckout(auth, email, sessionId)
    if (!r.paid) return json(res, 200, r)
    let t = null
    if (!authed) {
      t = token()
      auth.sessions[t] = { email, exp: Date.now() + 90 * 24 * 3600 * 1000 }
    }
    await saveAuth(auth)
    return json(res, 200, { paid: true, token: t, email, subUntil: r.subUntil })
  }

  // new Stripe Checkout session for a signed-in user renewing an expired subscription
  if (path === '/api/pay/renew' && req.method === 'POST') {
    if (!PAYMENTS_ENABLED) return json(res, 400, { error: 'payments disabled' })
    const email = sessionEmail(auth, req)
    if (!email) return json(res, 401, { error: 'ログインしていません' })
    const plan = body.plan === 'sub' ? 'sub' : 'month'
    const payment = await createCheckout(auth, email, plan, originOf(req))
    await saveAuth(auth)
    return json(res, 200, { payment })
  }

  // stop auto-renewal (subscription cancels at period end; access runs to subUntil)
  if (path === '/api/pay/cancel' && req.method === 'POST') {
    if (!PAYMENTS_ENABLED) return json(res, 400, { error: 'payments disabled' })
    const email = sessionEmail(auth, req)
    if (!email) return json(res, 401, { error: 'ログインしていません' })
    const r = await cancelSubscription(auth, email)
    if (r.cancelled) await saveAuth(auth)
    return json(res, 200, r)
  }

  // plan prices (for the register screen)
  if (path === '/api/pay/plans' && req.method === 'GET') {
    return json(res, 200, { enabled: PAYMENTS_ENABLED, plans: PLANS })
  }

  if (path === '/api/logout' && req.method === 'POST') {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')
    if (m) delete auth.sessions[m[1]]
    await saveAuth(auth)
    return json(res, 200, { ok: true })
  }

  if (path === '/api/forgot' && req.method === 'POST') {
    const email = (body.email ?? '').trim().toLowerCase()
    // always answer ok — don't leak which emails exist
    const u = auth.users.find((x) => x.email === email)
    if (u && RESEND_API_KEY) {
      const t = token()
      auth.resets[t] = { email, exp: Date.now() + 3600 * 1000 }
      await saveAuth(auth)
      const link = `https://${req.headers.host}/#reset=${t}`
      try {
        await sendResetEmail(email, link)
      } catch (e) {
        console.error('resend failed:', e.message)
        return json(res, 502, { error: 'メールを送信できませんでした — しばらくしてから再度お試しください' })
      }
    }
    return json(res, 200, { ok: true })
  }

  if (path === '/api/reset' && req.method === 'POST') {
    const r = auth.resets[body.token ?? '']
    if (!r || r.exp < Date.now()) return json(res, 400, { error: '再設定リンクが無効か期限切れです' })
    const password = body.password ?? ''
    if (password.length < 6) return json(res, 400, { error: 'パスワードは6文字以上にしてください' })
    const u = auth.users.find((x) => x.email === r.email)
    if (!u) return json(res, 400, { error: 'アカウントが見つかりません' })
    u.salt = randomBytes(16).toString('hex')
    u.pass = hashPassword(password, u.salt)
    delete auth.resets[body.token]
    await saveAuth(auth)
    return json(res, 200, { ok: true })
  }

  if (path === '/api/state' && req.method === 'GET') {
    const email = sessionEmail(auth, req)
    if (!email) return json(res, 401, { error: 'Not signed in' })
    const u = auth.users.find((x) => x.email === email)
    if (PAYMENTS_ENABLED && !subscriptionActive(u))
      return json(res, 402, { error: 'subscription expired', subUntil: u?.subUntil ?? 0 })
    try {
      const raw = await readFile(stateFile(email), 'utf8')
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(raw)
    } catch {
      return json(res, 200, { state: null })
    }
  }

  if (path === '/api/state' && req.method === 'PUT') {
    const email = sessionEmail(auth, req)
    if (!email) return json(res, 401, { error: 'Not signed in' })
    const u = auth.users.find((x) => x.email === email)
    if (PAYMENTS_ENABLED && !subscriptionActive(u))
      return json(res, 402, { error: 'subscription expired', subUntil: u?.subUntil ?? 0 })
    if (!body.state || !Array.isArray(body.state.cards)) return json(res, 400, { error: 'Bad state' })
    await mkdir(STATES, { recursive: true })
    await writeFile(stateFile(email), JSON.stringify(body.state))
    return json(res, 200, { ok: true })
  }

  // tab-close flush: apply a small batch of grades onto the saved state.
  // Sent via sendBeacon (POST, ?token= query auth) right before the tab dies,
  // so the last answer(s) inside the 1.5s debounce window are not lost.
  if (path === '/api/grades' && req.method === 'POST') {
    const email = sessionEmail(auth, req)
    if (!email) return json(res, 401, { error: 'Not signed in' })
    const u = auth.users.find((x) => x.email === email)
    if (PAYMENTS_ENABLED && !subscriptionActive(u))
      return json(res, 402, { error: 'subscription expired', subUntil: u?.subUntil ?? 0 })
    const grades = Array.isArray(body.grades) ? body.grades.slice(0, 200) : null
    if (!grades) return json(res, 400, { error: 'Bad grades' })
    const file = stateFile(email)
    let state
    try {
      state = JSON.parse(await readFile(file, 'utf8'))
    } catch {
      return json(res, 200, { ok: true, applied: 0 }) // no state yet — next full sync wins
    }
    if (!Array.isArray(state.cards)) return json(res, 200, { ok: true, applied: 0 })
    let applied = 0
    for (const g of grades) {
      if (!g?.card?.id || typeof g.key !== 'string') continue
      const i = state.cards.findIndex((c) => c.id === g.card.id)
      if (i === -1) continue
      state.cards[i] = g.card
      state.history = state.history ?? {}
      state.history[g.key] = (state.history[g.key] ?? 0) + 1
      if (g.wasNew) {
        state.introLog = state.introLog ?? {}
        state.introLog[g.key] = (state.introLog[g.key] ?? 0) + 1
      }
      applied++
    }
    if (applied) await writeFile(file, JSON.stringify(state))
    return json(res, 200, { ok: true, applied })
  }

  if (path === '/api/tts' && req.method === 'GET') {
    const url = new URL(req.url, 'http://x')
    const text = (url.searchParams.get('text') ?? '').trim().slice(0, 120)
    if (!text) return json(res, 400, { error: 'No text' })
    const file = join(TTS_DIR, createHash('sha1').update(text).digest('hex') + '.mp3')
    if (!existsSync(file)) {
      await mkdir(TTS_DIR, { recursive: true })
      let gen = ttsInflight.get(file)
      if (!gen) {
        gen = execFileAsync(
          TTS_PYTHON,
          ['-m', 'edge_tts', '--voice', TTS_VOICE, '--text', text, '--write-media', file],
          { timeout: 30_000 },
        ).finally(() => ttsInflight.delete(file))
        ttsInflight.set(file, gen)
      }
      try {
        await gen
      } catch (e) {
        console.error('tts failed:', e.message)
        return json(res, 502, { error: 'TTS failed' })
      }
    }
    res.writeHead(200, {
      'content-type': 'audio/mpeg',
      'cache-control': 'public, max-age=31536000, immutable',
    })
    return createReadStream(file).pipe(res)
  }

  return json(res, 404, { error: 'Not found' })
}

// ─── server ─────────────────────────────────────────────────────────────────

// ─── access log (one JSON line per request, powers the weekly traffic email) ─
const ACCESS_LOG = join(DATA, 'access.log')
function logAccess(req, res, path) {
  res.on('finish', () => {
    if (path.startsWith('/assets/') || path === '/favicon.ico') return // static noise
    const ip =
      (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress
    const line = JSON.stringify({ t: Date.now(), ip, m: req.method, p: path, s: res.statusCode })
    appendFile(ACCESS_LOG, line + '\n').catch(() => {})
  })
}

// one edge-tts generation per word at a time — concurrent requests for the
// same uncached audio share a single subprocess instead of stacking up
const ttsInflight = new Map()

// maintenance mode: MAINTENANCE=1 in the environment serves a polite holding
// page for every page request and 503s the API — flip it on before upgrades
const MAINTENANCE = process.env.MAINTENANCE === '1'
const MAINTENANCE_HTML = join(HERE, 'maintenance.html')

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  logAccess(req, res, path)
  try {
    // Stripe webhook — raw body required for signature verification,
    // so it bypasses handleApi's JSON parsing
    if (path === '/api/webhook/stripe' && req.method === 'POST') {
      let raw = ''
      req.on('data', (c) => {
        raw += c
        if (raw.length > 1_000_000) req.destroy()
      })
      await new Promise((resolve) => req.on('end', resolve))
      const auth = await loadAuth()
      const r = await handleWebhook(auth, raw, req.headers['stripe-signature'] ?? '')
      if (r.ok) await saveAuth(auth)
      return json(res, r.status, r.ok ? { received: true } : { error: r.error })
    }
    if (MAINTENANCE) {
      if (path.startsWith('/api/'))
        return json(res, 503, { error: 'ただいまメンテナンス中です — 数分後にもう一度お試しください' })
      res.writeHead(503, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        'retry-after': '300',
      })
      return res.end(await readFile(MAINTENANCE_HTML))
    }
    if (path.startsWith('/api/')) return await handleApi(req, res, path)

    let p = path === '/' ? '/index.html' : decodeURIComponent(path)
    const file = normalize(join(ROOT, p))
    if (!file.startsWith(ROOT)) throw new Error('bad path')
    let data
    try {
      data = await readFile(file)
    } catch {
      // no SPA fallback: the app has a single route (/), so unknown paths are
      // real 404s — keeps search engines from indexing infinite duplicate URLs
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('Not found')
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': file.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
    res.end(data)
  } catch (e) {
    console.error(e)
    if (!res.headersSent) json(res, 500, { error: 'server error' })
    else res.end()
  }
}).listen(PORT, () => console.log(`speak-english serving on :${PORT}`))
