// Stablecoin subscription payments: $5/month or $50/year in USDC or USDT,
// verified via the Etherscan V2 multichain API. No payment processor — users
// send to ETH_ADDRESS on any supported network, we match the incoming token
// transfer by exact amount (each intent gets a unique sub-cent nonce so
// concurrent payers never collide).
//
// Env:
//   ETH_ADDRESS        receiving address; EMPTY = payments disabled (free registration)
//   ETHERSCAN_API_KEY  Etherscan V2 API key (one key works for all chains)
//   SUB_MONTH_USD      default 5
//   SUB_YEAR_USD       default 50

const ETH_ADDRESS = (process.env.ETH_ADDRESS ?? '').trim()
const API_KEY = (process.env.ETHERSCAN_API_KEY ?? '').trim()
export const PAYMENTS_ENABLED = Boolean(ETH_ADDRESS && API_KEY)

export const PLANS = {
  month: { usd: parseFloat(process.env.SUB_MONTH_USD ?? '5'), days: 31 },
  year: { usd: parseFloat(process.env.SUB_YEAR_USD ?? '50'), days: 366 },
}

// Networks watched for incoming USDC/USDT (all verifiable via Etherscan V2).
// decimals: 6 everywhere except BSC, where both tokens use 18.
const TRACKED = [
  { chainid: 1, name: 'Ethereum', usdc: ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6], usdt: ['0xdAC17F958D2ee523a2206206994597C13D831ec7', 6] },
  { chainid: 42161, name: 'Arbitrum', usdc: ['0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 6], usdt: ['0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 6] },
  { chainid: 8453, name: 'Base', usdc: ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6], usdt: ['0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', 6] },
  { chainid: 10, name: 'Optimism', usdc: ['0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 6], usdt: ['0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', 6] },
  { chainid: 137, name: 'Polygon', usdc: ['0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 6], usdt: ['0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 6] },
  { chainid: 56, name: 'BSC', usdc: ['0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 18], usdt: ['0x55d398326f99059fF775485246999027B3197955', 18] },
]
// what the payer sees / what we tell them to send
export const ACCEPTED = 'USDC or USDT on Ethereum, Arbitrum, Base, Optimism, Polygon, or BSC'

const INTENT_TTL_MS = 2 * 3600 * 1000 // 2 h to complete a payment
const OVERPAY_BUFFER_USD = 0.01 // forgiveness on top of the exact amount

// ─── Etherscan V2 ────────────────────────────────────────────────────────────

const api = (chainid, params) =>
  `https://api.etherscan.io/v2/api?chainid=${chainid}&${params}&apikey=${API_KEY}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let txCache = { at: 0, txs: [] }
/** All recent incoming USDC/USDT transfers to ETH_ADDRESS across TRACKED chains.
 *  Each entry: { hash, timeStamp, value (BigInt, token base units), chain, symbol } */
async function incomingTransfers() {
  if (Date.now() - txCache.at < 60_000 && txCache.txs.length) return txCache.txs
  const out = []
  for (const chain of TRACKED) {
    for (const symbol of ['usdc', 'usdt']) {
      const [contract, decimals] = chain[symbol]
      try {
        const r = await fetch(
          api(
            chain.chainid,
            `module=account&action=tokentx&contractaddress=${contract}&address=${ETH_ADDRESS}&page=1&offset=100&sort=desc`,
          ),
        )
        const j = await r.json()
        for (const t of Array.isArray(j?.result) ? j.result : []) {
          if (t.to?.toLowerCase() !== ETH_ADDRESS.toLowerCase()) continue
          if (t.contractAddress?.toLowerCase() !== contract.toLowerCase()) continue
          out.push({
            hash: `${chain.chainid}:${t.hash}`,
            timeStamp: parseInt(t.timeStamp, 10),
            value: BigInt(t.value),
            chain: chain.name,
            symbol: symbol.toUpperCase(),
            decimals,
          })
        }
      } catch (e) {
        console.error(`pay: ${chain.name} ${symbol} query failed:`, e.message)
      }
      await sleep(250) // stay under the 5 calls/s free-tier limit
    }
  }
  txCache = { at: Date.now(), txs: out }
  return out
}

// ─── intents ─────────────────────────────────────────────────────────────────
// Amounts are expressed in 6-decimal "USD units" internally ($5 = 5_000_000)
// and converted per-token at match time.

const usdToUnits = (usd, decimals) =>
  BigInt(Math.round(usd * 10 ** 6)) * 10n ** BigInt(decimals - 6)

/** Create (or reuse a fresh) payment intent for an email. */
export async function createIntent(auth, email, plan) {
  const p = PLANS[plan]
  if (!p) throw new Error('bad plan')
  const now = Date.now()
  const existing = auth.payIntents?.[email]
  if (existing && existing.plan === plan && now - existing.createdAt < INTENT_TTL_MS) {
    return publicIntent(existing, p)
  }
  // $5.00 = 5_000_000 units; unique sub-cent nonce ($0.000001–$0.06) per payer
  const baseUnits = BigInt(Math.round(p.usd * 1e6))
  const nonce = BigInt(1 + Math.floor(Math.random() * 59_999))
  const intent = { plan, amount: (baseUnits + nonce).toString(), createdAt: now }
  if (!auth.payIntents) auth.payIntents = {}
  auth.payIntents[email] = intent
  return publicIntent(intent, p)
}

function publicIntent(intent, p) {
  const amount6 = BigInt(intent.amount)
  return {
    address: ETH_ADDRESS,
    amount: intent.amount, // 6-decimal USD units
    usdc: unitsToString(amount6, 6),
    usd: p.usd,
    plan: intent.plan,
    days: p.days,
    expiresAt: intent.createdAt + INTENT_TTL_MS,
    accepted: ACCEPTED,
    // QR pre-fills a mainnet-USDC transfer (EIP-681); manual senders may use
    // any token/network listed in `accepted`
    qr: `ethereum:${TRACKED[0].usdc[0]}/transfer?address=${ETH_ADDRESS}&uint256=${amount6}`,
  }
}

function unitsToString(amount, decimals) {
  const a = amount.toString().padStart(decimals + 1, '0')
  const whole = a.slice(0, -decimals) || '0'
  const frac = a.slice(-decimals).replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole
}

/** Check whether the intent for `email` has been paid on-chain.
 *  Returns { paid, subUntil } and, when paid, extends the subscription. */
export async function checkIntent(auth, email) {
  const intent = auth.payIntents?.[email]
  if (!intent || !PAYMENTS_ENABLED) return { paid: false }
  if (Date.now() - intent.createdAt > INTENT_TTL_MS) return { paid: false, expired: true }
  const minTs = Math.floor(intent.createdAt / 1000) - 600
  if (!auth.usedTx) auth.usedTx = []
  const txs = await incomingTransfers()
  const hit = txs.find((t) => {
    if (auth.usedTx.includes(t.hash)) return false
    if (t.timeStamp < minTs) return false
    const want6 = BigInt(intent.amount) // 6-decimal USD units
    const want = want6 * 10n ** BigInt(t.decimals - 6)
    const buffer = usdToUnits(OVERPAY_BUFFER_USD, t.decimals)
    return t.value >= want && t.value <= want + buffer
  })
  if (!hit) return { paid: false }
  auth.usedTx.push(hit.hash)
  const user = auth.users.find((u) => u.email === email)
  const p = PLANS[intent.plan]
  const base = Math.max(Date.now(), user?.subUntil ?? 0)
  const subUntil = base + p.days * 24 * 3600 * 1000
  if (user) user.subUntil = subUntil
  delete auth.payIntents[email]
  console.log(`pay: ${email} paid ${hit.symbol} on ${hit.chain} (${hit.hash})`)
  return { paid: true, subUntil }
}

export const subscriptionActive = (user) => Boolean(user?.subUntil && user.subUntil > Date.now())
