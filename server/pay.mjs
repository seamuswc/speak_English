// Stripe Checkout payments: ¥800 one-time card payment → subscription days.
// Env:
//   STRIPE_SECRET_KEY   Stripe secret key (sk_...)
//   SUB_DAYS            subscription days granted per payment (default 31)

import Stripe from 'stripe'

const STRIPE_SECRET = (process.env.STRIPE_SECRET_KEY ?? '').trim()
export const PAYMENTS_ENABLED = Boolean(STRIPE_SECRET)

// one persistent Stripe Price (¥800 JPY, product "Eigobot — 月額サブスクリプション")
// keeps the product catalog clean and per-site reporting possible; falls back
// to inline price_data when unset
const STRIPE_PRICE_ID = (process.env.STRIPE_PRICE_ID ?? '').trim()

const SUB_DAYS = parseInt(process.env.SUB_DAYS ?? '31', 10)

export const PLANS = {
  month: { jpy: 800, days: SUB_DAYS },
}

// ─── Stripe Checkout ─────────────────────────────────────────────────────────

let stripe = null
function getStripe() {
  if (!stripe) stripe = new Stripe(STRIPE_SECRET)
  return stripe
}

/** Create a Stripe Checkout session for an email.
 *  Returns { url, sessionId, plan, days } for redirecting the customer. */
export async function createCheckout(auth, email, plan, origin) {
  const p = PLANS[plan]
  if (!p) throw new Error('bad plan')

  const session = await getStripe().checkout.sessions.create({
    payment_method_types: ['card'],
    customer_email: email,
    locale: 'ja', // Japanese UI for Japanese customers
    // never convert the price into the customer's local currency — ¥ only
    adaptive_pricing: { enabled: false },
    line_items: [
      STRIPE_PRICE_ID
        ? { price: STRIPE_PRICE_ID, quantity: 1 }
        : {
            price_data: {
              currency: 'jpy',
              product_data: { name: 'Eigobot — 月額サブスクリプション' },
              unit_amount: p.jpy, // JPY is a zero-decimal currency: 800 = ¥800
            },
            quantity: 1,
          },
    ],
    mode: 'payment',
    success_url: `${origin}/?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/`,
    metadata: { email, plan, site: 'eigobot' },
    payment_intent_data: { metadata: { email, plan, site: 'eigobot' } },
  })

  // Track the session so we can verify it later
  if (!auth.stripeSessions) auth.stripeSessions = {}
  auth.stripeSessions[session.id] = { email, plan, createdAt: Date.now() }

  return { url: session.url, sessionId: session.id, plan, days: p.days }
}

/** Verify a Stripe Checkout session and, if paid, extend the subscription.
 *  Returns { paid, subUntil } */
export async function verifyCheckout(auth, email, sessionId) {
  if (!PAYMENTS_ENABLED) return { paid: false }

  const sess = auth.stripeSessions?.[sessionId]
  if (!sess || sess.email !== email) return { paid: false }

  // Prevent replay
  if (!auth.usedStripeSessions) auth.usedStripeSessions = []
  if (auth.usedStripeSessions.includes(sessionId)) return { paid: false }

  const session = await getStripe().checkout.sessions.retrieve(sessionId)
  if (session.payment_status !== 'paid') return { paid: false }

  auth.usedStripeSessions.push(sessionId)

  const plan = sess.plan
  const p = PLANS[plan]
  const now = Date.now()

  // Payment ledger
  if (!auth.payments) auth.payments = []
  auth.payments.push({
    email,
    plan,
    jpy: p.jpy,
    tx: sessionId,
    t: now,
  })

  if (auth.pendingRegs?.[email]) {
    const pending = auth.pendingRegs[email]
    const subUntil = now + p.days * 24 * 3600 * 1000
    auth.users.push({ ...pending, createdAt: pending.createdAt ?? now, subUntil })
    delete auth.pendingRegs[email]
    console.log(`pay: ${email} registered via Stripe → ${sessionId}`)
    return { paid: true, subUntil }
  }

  const user = auth.users.find((u) => u.email === email)
  const base = Math.max(now, user?.subUntil ?? 0)
  const subUntil = base + p.days * 24 * 3600 * 1000
  if (user) user.subUntil = subUntil
  console.log(`pay: ${email} renewed via Stripe → ${sessionId}`)
  return { paid: true, subUntil }
}

export const subscriptionActive = (user) => Boolean(user?.subUntil && user.subUntil > Date.now())
