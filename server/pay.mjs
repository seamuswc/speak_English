// Stablecoin subscription payments: $5/month or $50/year in USDC or USDT.
// Every payment intent gets its OWN receiving address, derived from the
// business HD wallet's xpub (BIP-44 m/44'/60'/0'/0/<index>) — the server can
// generate addresses and watch them, but mathematically cannot spend: the
// private key never touches this machine.
//
// Env:
//   HD_XPUB            account-level xpub; EMPTY = payments disabled (free registration)
//   ETHERSCAN_API_KEY  Etherscan V2 API key (one key works for all chains)
//   ADDRESS_OFFSET     first derivation index (different per site sharing the wallet)
//   SUB_MONTH_USD      default 5
//   SUB_YEAR_USD       default 50

import { HDKey } from '@scure/bip32'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'

const HD_XPUB = (process.env.HD_XPUB ?? '').trim()
const API_KEY = (process.env.ETHERSCAN_API_KEY ?? '').trim()
export const PAYMENTS_ENABLED = Boolean(HD_XPUB && API_KEY)

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
export const ACCEPTED = 'USDC or USDT on Ethereum, Arbitrum, Base, Optimism, Polygon, or BSC'

const INTENT_TTL_MS = 2 * 3600 * 1000 // 2 h to complete a payment

// ─── address derivation (public only — no private key anywhere near here) ───

let hd = null
export function deriveAddress(index) {
  if (!hd) hd = HDKey.fromExtendedKey(HD_XPUB)
  const child = hd.deriveChild(index)
  const uncompressed = secp256k1.Point.fromHex(
    Buffer.from(child.publicKey).toString('hex'),
  ).toBytes(false)
  const hash = keccak_256(uncompressed.slice(1))
  return '0x' + Buffer.from(hash.slice(-20)).toString('hex')
}

// ─── Etherscan V2 ────────────────────────────────────────────────────────────

const api = (chainid, params) =>
  `https://api.etherscan.io/v2/api?chainid=${chainid}&${params}&apikey=${API_KEY}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const txCaches = new Map() // address → { at, txs }
/** Recent incoming USDC/USDT transfers to `address` across TRACKED chains. */
async function incomingTransfers(address) {
  const cached = txCaches.get(address)
  if (cached && Date.now() - cached.at < 60_000) return cached.txs
  const out = []
  for (const chain of TRACKED) {
    for (const symbol of ['usdc', 'usdt']) {
      const [contract, decimals] = chain[symbol]
      try {
        const r = await fetch(
          api(
            chain.chainid,
            `module=account&action=tokentx&contractaddress=${contract}&address=${address}&page=1&offset=100&sort=desc`,
          ),
        )
        const j = await r.json()
        for (const t of Array.isArray(j?.result) ? j.result : []) {
          if (t.to?.toLowerCase() !== address.toLowerCase()) continue
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
  txCaches.set(address, { at: Date.now(), txs: out })
  return out
}

// ─── intents ─────────────────────────────────────────────────────────────────

const unitsToString = (usd) => (Number.isInteger(usd) ? `${usd}` : usd.toFixed(2))

/** Create (or reuse a fresh) payment intent for an email. */
export async function createIntent(auth, email, plan) {
  const p = PLANS[plan]
  if (!p) throw new Error('bad plan')
  const now = Date.now()
  const existing = auth.payIntents?.[email]
  if (existing && existing.plan === plan && now - existing.createdAt < INTENT_TTL_MS) {
    return publicIntent(existing, p)
  }
  // brand-new derived address for this payment (per-site offset keeps sites
  // sharing one wallet from ever handing out the same address)
  if (auth.nextAddressIndex === undefined)
    auth.nextAddressIndex = parseInt(process.env.ADDRESS_OFFSET ?? '0', 10)
  const index = auth.nextAddressIndex++
  const intent = { plan, index, address: deriveAddress(index), createdAt: now }
  if (!auth.payIntents) auth.payIntents = {}
  auth.payIntents[email] = intent
  return publicIntent(intent, p)
}

function publicIntent(intent, p) {
  return {
    address: intent.address,
    usdc: unitsToString(p.usd), // clean amount: "5" or "50"
    usd: p.usd,
    plan: intent.plan,
    days: p.days,
    expiresAt: intent.createdAt + INTENT_TTL_MS,
    accepted: ACCEPTED,
    // QR pre-fills a mainnet-USDC transfer (EIP-681); manual senders may use
    // any token/network listed in `accepted`
    qr: `ethereum:${TRACKED[0].usdc[0]}/transfer?address=${intent.address}&uint256=${BigInt(Math.round(p.usd * 1e6))}`,
  }
}

/** Check whether the intent for `email` has been paid on-chain.
 *  Returns { paid, subUntil } and, when paid, extends the subscription. */
export async function checkIntent(auth, email) {
  const intent = auth.payIntents?.[email]
  if (!intent || !PAYMENTS_ENABLED) return { paid: false }
  if (Date.now() - intent.createdAt > INTENT_TTL_MS) return { paid: false, expired: true }
  const p = PLANS[intent.plan]
  if (!auth.usedTx) auth.usedTx = []
  const txs = await incomingTransfers(intent.address)
  const hit = txs.find((t) => {
    if (auth.usedTx.includes(t.hash)) return false
    const want = BigInt(Math.round(p.usd * 10 ** 6)) * 10n ** BigInt(t.decimals - 6)
    return t.value >= want
  })
  if (!hit) return { paid: false }
  auth.usedTx.push(hit.hash)
  const user = auth.users.find((u) => u.email === email)
  const base = Math.max(Date.now(), user?.subUntil ?? 0)
  const subUntil = base + p.days * 24 * 3600 * 1000
  if (user) user.subUntil = subUntil
  delete auth.payIntents[email]
  console.log(`pay: ${email} paid ${hit.symbol} on ${hit.chain} → ${intent.address} (${hit.hash})`)
  return { paid: true, subUntil }
}

export const subscriptionActive = (user) => Boolean(user?.subUntil && user.subUntil > Date.now())
