// ETH subscription payments: $5/month or $50/year, verified via Etherscan.
// No payment processor — users send ETH to ETH_ADDRESS, we match the incoming
// transaction by exact wei amount (each intent gets a unique wei nonce).
//
// Env:
//   ETH_ADDRESS        receiving address; EMPTY = payments disabled (free registration)
//   ETHERSCAN_API_KEY  Etherscan V2 API key
//   SUB_MONTH_USD      default 5
//   SUB_YEAR_USD       default 50

const ETH_ADDRESS = (process.env.ETH_ADDRESS ?? '').trim()
const API_KEY = (process.env.ETHERSCAN_API_KEY ?? '').trim()
export const PAYMENTS_ENABLED = Boolean(ETH_ADDRESS && API_KEY)

export const PLANS = {
  month: { usd: parseFloat(process.env.SUB_MONTH_USD ?? '5'), days: 31 },
  year: { usd: parseFloat(process.env.SUB_YEAR_USD ?? '50'), days: 366 },
}

const INTENT_TTL_MS = 2 * 3600 * 1000 // 2 h to complete a payment
const OVERPAY_BUFFER_WEI = 1_000_000_000_000_000n // 0.001 ETH forgiveness on top

// ─── Etherscan (V2 multichain API, chainid=1 = mainnet) ─────────────────────

const api = (params) =>
  `https://api.etherscan.io/v2/api?chainid=1&${params}&apikey=${API_KEY}`

let priceCache = { at: 0, usd: 0 }
export async function ethPriceUsd() {
  if (Date.now() - priceCache.at < 5 * 60_000 && priceCache.usd) return priceCache.usd
  const r = await fetch(api('module=stats&action=ethprice'))
  const j = await r.json()
  const usd = parseFloat(j?.result?.ethusd ?? '')
  if (!usd) throw new Error('eth price unavailable')
  priceCache = { at: Date.now(), usd }
  return usd
}

let txCache = { at: 0, txs: [] }
async function incomingTxs() {
  if (Date.now() - txCache.at < 30_000 && txCache.txs.length) return txCache.txs
  const r = await fetch(
    api(
      `module=account&action=txlist&address=${ETH_ADDRESS}&startblock=0&endblock=99999999&page=1&offset=200&sort=desc`,
    ),
  )
  const j = await r.json()
  const txs = (Array.isArray(j?.result) ? j.result : []).filter(
    (t) => t.to?.toLowerCase() === ETH_ADDRESS.toLowerCase() && t.isError === '0',
  )
  txCache = { at: Date.now(), txs }
  return txs
}

// ─── intents ─────────────────────────────────────────────────────────────────

/** Create (or reuse a fresh) payment intent for an email. */
export async function createIntent(auth, email, plan) {
  const p = PLANS[plan]
  if (!p) throw new Error('bad plan')
  const now = Date.now()
  const existing = auth.payIntents?.[email]
  if (existing && existing.plan === plan && now - existing.createdAt < INTENT_TTL_MS) {
    return publicIntent(existing, p)
  }
  const ethUsd = await ethPriceUsd()
  const baseWei = BigInt(Math.round((p.usd / ethUsd) * 1e18))
  // unique wei nonce (≪ $0.0001) so concurrent payers never collide
  const nonce = BigInt(Math.floor(Math.random() * 60_000))
  const intent = { plan, wei: (baseWei + nonce).toString(), createdAt: now }
  if (!auth.payIntents) auth.payIntents = {}
  auth.payIntents[email] = intent
  return publicIntent(intent, p)
}

function publicIntent(intent, p) {
  return {
    address: ETH_ADDRESS,
    wei: intent.wei,
    eth: weiToEthString(intent.wei),
    usd: p.usd,
    plan: intent.plan,
    days: p.days,
    expiresAt: intent.createdAt + INTENT_TTL_MS,
  }
}

function weiToEthString(wei) {
  const w = wei.padStart(19, '0')
  const whole = w.slice(0, -18) || '0'
  const frac = w.slice(-18).replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole
}

/** Check whether the intent for `email` has been paid on-chain.
 *  Returns { paid, subUntil } and, when paid, extends the subscription. */
export async function checkIntent(auth, email) {
  const intent = auth.payIntents?.[email]
  if (!intent || !PAYMENTS_ENABLED) return { paid: false }
  if (Date.now() - intent.createdAt > INTENT_TTL_MS) return { paid: false, expired: true }
  const want = BigInt(intent.wei)
  const minTs = Math.floor(intent.createdAt / 1000) - 600
  if (!auth.usedTx) auth.usedTx = []
  const txs = await incomingTxs()
  const hit = txs.find((t) => {
    if (auth.usedTx.includes(t.hash)) return false
    if (parseInt(t.timeStamp, 10) < minTs) return false
    const v = BigInt(t.value)
    return v >= want && v <= want + OVERPAY_BUFFER_WEI
  })
  if (!hit) return { paid: false }
  auth.usedTx.push(hit.hash)
  const user = auth.users.find((u) => u.email === email)
  const p = PLANS[intent.plan]
  const base = Math.max(Date.now(), user?.subUntil ?? 0)
  const subUntil = base + p.days * 24 * 3600 * 1000
  if (user) user.subUntil = subUntil
  delete auth.payIntents[email]
  return { paid: true, subUntil }
}

export const subscriptionActive = (user) => Boolean(user?.subUntil && user.subUntil > Date.now())
