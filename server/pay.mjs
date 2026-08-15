// Stripe payments for Eigobot.
// Two plans, both ¥800:
//   month  one-time payment → 31 days of access (no auto-renew)
//   sub    monthly subscription (mode: subscription) → auto-renews; each
//          successful renewal invoice (webhook) adds another 31 days
// Env:
//   STRIPE_SECRET_KEY        Stripe secret key (sk_...)
//   STRIPE_PRICE_ID          one-time ¥800 price (falls back to inline price_data)
//   STRIPE_SUB_PRICE_ID      recurring ¥800/month price (required for plan "sub")
//   STRIPE_WEBHOOK_SECRET    whsec_... for /api/webhook/stripe signature checks
//   SUB_DAYS                 days granted per payment (default 31)

import Stripe from 'stripe'

const STRIPE_SECRET = (process.env.STRIPE_SECRET_KEY ?? '').trim()
export const PAYMENTS_ENABLED = Boolean(STRIPE_SECRET)

const STRIPE_PRICE_ID = (process.env.STRIPE_PRICE_ID ?? '').trim()
const STRIPE_SUB_PRICE_ID = (process.env.STRIPE_SUB_PRICE_ID ?? '').trim()
const STRIPE_WEBHOOK_SECRET = (process.env.STRIPE_WEBHOOK_SECRET ?? '').trim()

const SUB_DAYS = parseInt(process.env.SUB_DAYS ?? '31', 10)

export const PLANS = {
  month: { jpy: 800, days: SUB_DAYS, label: '1か月のみ', recurring: false },
  sub: { jpy: 800, days: SUB_DAYS, label: '月額（自動更新）', recurring: true },
}

let stripe = null
function getStripe() {
  if (!stripe) stripe = new Stripe(STRIPE_SECRET)
  return stripe
}

const MS_DAY = 24 * 3600 * 1000

/** Create a Stripe Checkout session for an email.
 *  Returns { url, sessionId, plan, days } for redirecting the customer. */
export async function createCheckout(auth, email, plan, origin) {
  const p = PLANS[plan]
  if (!p) throw new Error('bad plan')

  const shared = {
    customer_email: email,
    locale: 'ja', // Japanese UI for Japanese customers
    // never convert the price into the customer's local currency — ¥ only
    adaptive_pricing: { enabled: false },
    success_url: `${origin}/?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/`,
    metadata: { email, plan, site: 'eigobot' },
  }

  let session
  if (p.recurring) {
    if (!STRIPE_SUB_PRICE_ID) throw new Error('subscription price not configured')
    session = await getStripe().checkout.sessions.create({
      ...shared,
      mode: 'subscription',
      // subscriptions renew automatically → card only (PayPay/konbini are one-time)
      payment_method_types: ['card'],
      line_items: [{ price: STRIPE_SUB_PRICE_ID, quantity: 1 }],
      subscription_data: { metadata: { email, plan, site: 'eigobot' } },
    })
  } else {
    const oneTimeSession = (methods) =>
      getStripe().checkout.sessions.create({
        ...shared,
        mode: 'payment',
        // Japanese local methods: card (incl. JCB), PayPay, konbini (コンビニ払い).
        // konbini pays asynchronously — access is granted by the webhook on
        // checkout.session.async_payment_succeeded, not at redirect time
        payment_method_types: methods,
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
        payment_intent_data: { metadata: { email, plan, site: 'eigobot' } },
      })
    try {
      session = await oneTimeSession(['card', 'paypay', 'konbini'])
    } catch (e) {
      // PayPay/konbini not activated on the account yet — degrade to card-only
      // so checkout keeps working either way
      if (!/payment method type/i.test(e.message ?? '')) throw e
      console.warn('pay: local payment methods unavailable, falling back to card-only')
      session = await oneTimeSession(['card'])
    }
  }

  // Track the session so we can verify it later
  if (!auth.stripeSessions) auth.stripeSessions = {}
  auth.stripeSessions[session.id] = { email, plan, createdAt: Date.now() }

  return { url: session.url, sessionId: session.id, plan, days: p.days }
}

/** Promote a pending registration or extend an existing user. Caller saves. */
function grantAccess(auth, email, plan, subId) {
  const p = PLANS[plan] ?? PLANS.month
  const now = Date.now()
  let subUntil

  if (auth.pendingRegs?.[email]) {
    const pending = auth.pendingRegs[email]
    subUntil = now + p.days * MS_DAY
    const user = { ...pending, createdAt: pending.createdAt ?? now, subUntil }
    if (subId) user.stripeSub = subId
    auth.users.push(user)
    delete auth.pendingRegs[email]
    return { subUntil, isNew: true }
  }

  const user = auth.users.find((u) => u.email === email)
  const base = Math.max(now, user?.subUntil ?? 0)
  subUntil = base + p.days * MS_DAY
  if (user) {
    user.subUntil = subUntil
    if (subId) user.stripeSub = subId
  }
  return { subUntil, isNew: false }
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
  const now = Date.now()

  if (session.mode === 'subscription') {
    if (session.status !== 'complete' || !session.subscription) return { paid: false }
    const sub = await getStripe().subscriptions.retrieve(session.subscription)
    if (sub.status !== 'active' && sub.status !== 'trialing') return { paid: false }

    auth.usedStripeSessions.push(sessionId)
    const { subUntil, isNew } = grantAccess(auth, email, sess.plan, sub.id)
    if (!auth.payments) auth.payments = []
    auth.payments.push({ email, plan: sess.plan, jpy: PLANS[sess.plan].jpy, tx: sessionId, sub: sub.id, t: now })
    console.log(`pay: ${email} ${isNew ? 'registered' : 'renewed'} via Stripe subscription ${sub.id}`)
    return { paid: true, subUntil }
  }

  if (session.payment_status !== 'paid') return { paid: false }

  auth.usedStripeSessions.push(sessionId)
  const { subUntil, isNew } = grantAccess(auth, email, sess.plan, null)
  if (!auth.payments) auth.payments = []
  auth.payments.push({ email, plan: sess.plan, jpy: PLANS[sess.plan].jpy, tx: sessionId, t: now })
  console.log(`pay: ${email} ${isNew ? 'registered' : 'renewed'} via Stripe → ${sessionId}`)
  return { paid: true, subUntil }
}

/** Cancel a user's auto-renewing subscription at period end.
 *  Access continues until subUntil. Returns { cancelled } */
export async function cancelSubscription(auth, email) {
  const user = auth.users.find((u) => u.email === email)
  if (!user?.stripeSub) return { cancelled: false }
  try {
    const sub = await getStripe().subscriptions.update(user.stripeSub, {
      cancel_at_period_end: true,
    })
    delete user.stripeSub
    console.log(`pay: ${email} cancelled auto-renew (${sub.id}, ends at period end)`)
    return { cancelled: true }
  } catch (e) {
    console.error(`pay: cancel failed for ${email}: ${e.message}`)
    return { cancelled: false }
  }
}

/** Stripe webhook: extend access when a subscription renewal invoice is paid.
 *  rawBody must be the unparsed request body (signature verification). */
export async function handleWebhook(auth, rawBody, signature) {
  if (!STRIPE_WEBHOOK_SECRET) return { ok: false, status: 400, error: 'webhook not configured' }

  let event
  try {
    event = getStripe().webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET)
  } catch (e) {
    return { ok: false, status: 400, error: `bad signature: ${e.message}` }
  }

  if (event.type === 'invoice.paid') {
    const invoice = event.data.object
    const subId = invoice.subscription
    if (subId && invoice.billing_reason === 'subscription_cycle') {
      const user = auth.users.find((u) => u.stripeSub === subId)
      if (user) {
        const now = Date.now()
        const base = Math.max(now, user.subUntil ?? 0)
        user.subUntil = base + PLANS.sub.days * MS_DAY
        if (!auth.payments) auth.payments = []
        auth.payments.push({
          email: user.email,
          plan: 'sub',
          jpy: PLANS.sub.jpy,
          tx: invoice.id,
          sub: subId,
          t: now,
        })
        console.log(`pay: ${user.email} auto-renewed via invoice ${invoice.id}`)
        return { ok: true, status: 200 }
      }
      console.warn(`pay: renewal invoice ${invoice.id} for unknown subscription ${subId}`)
    }
  }

  // konbini (コンビニ払い) completes asynchronously: the customer leaves
  // checkout with a payment slip and pays at the store hours later — grant
  // access when Stripe confirms the money arrived
  if (event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object
    const { email, plan } = session.metadata ?? {}
    if (email && session.payment_status === 'paid') {
      if (!auth.usedStripeSessions) auth.usedStripeSessions = []
      if (auth.usedStripeSessions.includes(session.id)) return { ok: true, status: 200 }
      auth.usedStripeSessions.push(session.id)
      const { subUntil, isNew } = grantAccess(auth, email, plan ?? 'month', null)
      if (!auth.payments) auth.payments = []
      auth.payments.push({
        email,
        plan: plan ?? 'month',
        jpy: (PLANS[plan] ?? PLANS.month).jpy,
        tx: session.id,
        t: Date.now(),
      })
      console.log(
        `pay: ${email} ${isNew ? 'registered' : 'renewed'} via async payment (konbini) → ${session.id}, until ${new Date(subUntil).toISOString()}`,
      )
    }
  }

  if (event.type === 'checkout.session.async_payment_failed') {
    console.warn(`pay: async payment failed for session ${event.data.object?.id}`)
  }

  return { ok: true, status: 200 } // acknowledged, nothing to do
}

export const subscriptionActive = (user) => Boolean(user?.subUntil && user.subUntil > Date.now())
