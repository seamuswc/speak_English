// USDC subscription payments: $5/month or $50/year, verified via Etherscan.
// No payment processor — users send USDC (ERC-20, Ethereum mainnet) to
// ETH_ADDRESS, we match the incoming token transfer by exact amount (each
// intent gets a unique sub-cent nonce so concurrent payers never collide).
//
// Env:
//   ETH_ADDRESS        receiving address; EMPTY = payments disabled (free registration)
//   ETHERSCAN_API_KEY  Etherscan V2 API key
//   USDC_CONTRACT      defaults to mainnet USDC
//   SUB_MONTH_USD      default 5
//   SUB_YEAR_USD       default 50

const ETH_ADDRESS = (process.env.ETH_ADDRESS ?? '').trim()
const API_KEY = (process.env.ETHERSCAN_API_KEY ?? '').trim()
const USDC_CONTRACT = (
  process.env.USDC_CONTRACT ?? '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
).trim()
export const PAYMENTS_ENABLED = Boolean(ETH_ADDRESS && API_KEY)

export const PLANS = {
  month: { usd: parseFloat(process.env.SUB_MONTH_USD ?? '5'), days: 31 },
  year: { usd: parseFloat(process.env.SUB_YEAR_USD ?? '50'), days: 366 },
}

const INTENT_TTL_MS = 2 * 3600 * 1000 // 2 h to complete a payment
const OVERPAY_BUFFER = 10_000n // 0.01 USDC forgiveness on top (6 decimals)

// ─── Etherscan (V2 multichain API, chainid=1 = mainnet) ─────────────────────

const api = (params) =>
  `https://api.etherscan.io/v2/api?chainid=1&${params}&apikey=${API_KEY}`

let txCache = { at: 0, txs: [] }
async function incomingTransfers() {
  if (Date.now() - txCache.at < 30_000 && txCache.txs.length) return txCache.txs
  const r = await fetch(
    api(
      `module=account&action=tokentx&contractaddress=${USDC_CONTRACT}&address=${ETH_ADDRESS}&page=1&offset=200&sort=desc`,
    ),
  )
  const j = await r.json()
  const txs = (Array.isArray(j?.result) ? j.result : []).filter(
    (t) =>
      t.to?.toLowerCase() === ETH_ADDRESS.toLowerCase() &&
      t.contractAddress?.toLowerCase() === USDC_CONTRACT.toLowerCase(),
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
  // USDC has 6 decimals: $5.00 = 5_000_000 base units
  const baseUnits = BigInt(Math.round(p.usd * 1e6))
  // unique sub-cent nonce ($0.000001 – $0.06) so concurrent payers never collide
  const nonce = BigInt(1 + Math.floor(Math.random() * 59_999))
  const intent = { plan, amount: (baseUnits + nonce).toString(), createdAt: now }
  if (!auth.payIntents) auth.payIntents = {}
  auth.payIntents[email] = intent
  return publicIntent(intent, p)
}

function publicIntent(intent, p) {
  return {
    address: ETH_ADDRESS,
    amount: intent.amount, // USDC base units (6 decimals)
    usdc: unitsToUsdcString(intent.amount),
    usd: p.usd,
    plan: intent.plan,
    days: p.days,
    expiresAt: intent.createdAt + INTENT_TTL_MS,
    // EIP-681: wallet apps pre-fill a USDC transfer from this QR
    qr: `ethereum:${USDC_CONTRACT}/transfer?address=${ETH_ADDRESS}&uint256=${intent.amount}`,
  }
}

function unitsToUsdcString(amount) {
  const a = amount.padStart(7, '0')
  const whole = a.slice(0, -6) || '0'
  const frac = a.slice(-6).replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole
}

/** Check whether the intent for `email` has been paid on-chain.
 *  Returns { paid, subUntil } and, when paid, extends the subscription. */
export async function checkIntent(auth, email) {
  const intent = auth.payIntents?.[email]
  if (!intent || !PAYMENTS_ENABLED) return { paid: false }
  if (Date.now() - intent.createdAt > INTENT_TTL_MS) return { paid: false, expired: true }
  const want = BigInt(intent.amount)
  const minTs = Math.floor(intent.createdAt / 1000) - 600
  if (!auth.usedTx) auth.usedTx = []
  const txs = await incomingTransfers()
  const hit = txs.find((t) => {
    if (auth.usedTx.includes(t.hash)) return false
    if (parseInt(t.timeStamp, 10) < minTs) return false
    const v = BigInt(t.value)
    return v >= want && v <= want + OVERPAY_BUFFER
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
