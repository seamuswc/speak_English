// Speak English server: static web app + auth API + progress sync + password recovery.
// Zero-dependency (Node 20+). Passwords: scrypt. Sessions/reset: random tokens.
// Storage: server/data/auth.json + server/data/states/<hash>.json
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, extname, normalize, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createReadStream } from 'node:fs'

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
  const s = m && auth.sessions[m[1]]
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
        <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:-0.3px;">🎓 Speak English</span>
        <span style="color:#a7f3d0;font-size:13px;float:right;line-height:28px;">英語 · 0 → 流暢</span>
      </div>
      <div style="padding:32px;">
        <h1 style="margin:0 0 8px;font-size:22px;font-weight:600;color:#1c1917;">パスワードの再設定</h1>
        <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#57534e;">
          Speak English アカウントのパスワード再設定リクエストを受け付けました。
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
      Speak English — 日本人のための英単語トレーナー
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
      from: 'Speak English <noreply@support.govoru.xyz>',
      to: [email],
      subject: 'パスワードの再設定 — Speak English',
      html: resetEmailHtml(link),
      text: `Speak English のパスワードを再設定します (リンクの有効期限は1時間):\n${link}\n\n心当たりがない場合は、このメールを無視してください。`,
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
    auth.users.push({ email, salt, pass: hashPassword(password, salt), createdAt: Date.now() })
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
    return json(res, 200, { token: t, email })
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
      const link = `http://${req.headers.host}/#reset=${t}`
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
    if (!body.state || !Array.isArray(body.state.cards)) return json(res, 400, { error: 'Bad state' })
    await mkdir(STATES, { recursive: true })
    await writeFile(stateFile(email), JSON.stringify(body.state))
    return json(res, 200, { ok: true })
  }

  if (path === '/api/tts' && req.method === 'GET') {
    const url = new URL(req.url, 'http://x')
    const text = (url.searchParams.get('text') ?? '').trim().slice(0, 120)
    if (!text) return json(res, 400, { error: 'No text' })
    const file = join(TTS_DIR, createHash('sha1').update(text).digest('hex') + '.mp3')
    if (!existsSync(file)) {
      await mkdir(TTS_DIR, { recursive: true })
      try {
        await execFileAsync(
          TTS_PYTHON,
          ['-m', 'edge_tts', '--voice', TTS_VOICE, '--text', text, '--write-media', file],
          { timeout: 30_000 },
        )
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

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  try {
    if (path.startsWith('/api/')) return await handleApi(req, res, path)

    let p = path === '/' ? '/index.html' : decodeURIComponent(path)
    const file = normalize(join(ROOT, p))
    if (!file.startsWith(ROOT)) throw new Error('bad path')
    let data
    try {
      data = await readFile(file)
    } catch {
      data = await readFile(join(ROOT, 'index.html')) // SPA fallback
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
