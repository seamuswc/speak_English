// Client for the Speak English auth/sync API (server/app.mjs).
import type { AppState } from './srs'

export interface Auth {
  token: string
  email: string
  /** epoch ms the paid subscription ends; undefined = payments disabled */
  subUntil?: number
}

export interface PaymentInfo {
  /** Stripe Checkout URL to redirect the customer */
  url: string
  sessionId: string
  plan: 'month' | 'year'
  days: number
}

export type RegisterResult =
  | Auth
  | { paymentRequired: true; payment: PaymentInfo; email: string }

const AUTH_KEY = 'speak-english:auth'

export function loadAuth(): Auth | null {
  try {
    const a = JSON.parse(localStorage.getItem(AUTH_KEY) ?? 'null')
    return a && a.token && a.email ? a : null
  } catch {
    return null
  }
}

export function saveAuth(a: Auth | null) {
  if (a) localStorage.setItem(AUTH_KEY, JSON.stringify(a))
  else localStorage.removeItem(AUTH_KEY)
}

async function call<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const r = await fetch(path, {
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    ...opts,
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error ?? `error ${r.status}`)
  return j as T
}

export const apiRegister = (email: string, password: string) =>
  call<RegisterResult>('/api/register', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })

export const apiPayCheck = (email: string | null, token: string | null, sessionId: string) =>
  call<{ paid: boolean; token?: string | null; email?: string; subUntil?: number }>(
    '/api/pay/check',
    {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: JSON.stringify({ email, sessionId }),
    },
  )

export const apiPayRenew = (token: string, plan: 'month' | 'year' = 'month') =>
  call<{ payment: PaymentInfo }>('/api/pay/renew', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ plan }),
  })

// ─── Stripe redirect handoff ────────────────────────────────────────────────
// Before redirecting to Stripe Checkout we stash { email, sessionId } so the
// success_url return (/?session_id=…) can be matched to this browser.

const PENDING_KEY = 'speak-english:pendingPay'

export interface PendingPay {
  email: string
  sessionId: string
}

export function savePendingPay(p: PendingPay) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(p))
  } catch {
    // private browsing / storage disabled — the Stripe return screen will
    // show a recoverable error instead of crashing the checkout handoff
  }
}

export function loadPendingPay(): PendingPay | null {
  try {
    const p = JSON.parse(localStorage.getItem(PENDING_KEY) ?? 'null')
    return p && p.email && p.sessionId ? p : null
  } catch {
    return null
  }
}

export function clearPendingPay() {
  localStorage.removeItem(PENDING_KEY)
}

export const apiLogin = (email: string, password: string) =>
  call<Auth>('/api/login', { method: 'POST', body: JSON.stringify({ email, password }) })

export const apiLogout = (token: string) =>
  call('/api/logout', { method: 'POST', headers: { authorization: `Bearer ${token}` } }).catch(
    () => {},
  )

export const apiForgot = (email: string) =>
  call<{ ok: boolean }>('/api/forgot', { method: 'POST', body: JSON.stringify({ email }) })

export const apiReset = (token: string, password: string) =>
  call<{ ok: boolean }>('/api/reset', { method: 'POST', body: JSON.stringify({ token, password }) })

export async function apiGetState(token: string): Promise<AppState | null> {
  const j = await call<{ state: AppState | null } | AppState>('/api/state', {
    headers: { authorization: `Bearer ${token}` },
  })
  // server returns raw state when present, { state: null } when absent
  return 'state' in j ? j.state : (j as AppState)
}

export const apiPutState = (token: string, state: AppState) =>
  call('/api/state', {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ state }),
  })

export interface PendingGrade {
  card: unknown
  wasNew: boolean
  key: string
}

/** Tab-close flush: beacon any grades still inside the debounce window.
 *  sendBeacon can't set headers, so the token rides in the query string. */
export function beaconGrades(token: string, grades: PendingGrade[]) {
  if (!grades.length || typeof navigator === 'undefined' || !navigator.sendBeacon) return
  const blob = new Blob([JSON.stringify({ grades })], { type: 'application/json' })
  navigator.sendBeacon(`/api/grades?token=${encodeURIComponent(token)}`, blob)
}
