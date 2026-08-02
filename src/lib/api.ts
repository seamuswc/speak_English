// Client for the Speak English auth/sync API (server/app.mjs).
import type { AppState } from './srs'

export interface Auth {
  token: string
  email: string
  /** epoch ms the paid subscription ends; undefined = payments disabled */
  subUntil?: number
}

export interface PaymentInfo {
  address: string
  wei: string
  eth: string
  usd: number
  plan: 'month' | 'year'
  days: number
  expiresAt: number
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

export const apiRegister = (email: string, password: string, plan: 'month' | 'year' = 'month') =>
  call<RegisterResult>('/api/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, plan }),
  })

export const apiPayCheck = (email: string | null, token: string | null) =>
  call<{ paid: boolean; token?: string | null; email?: string; subUntil?: number; expired?: boolean }>(
    '/api/pay/check',
    {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: JSON.stringify(email ? { email } : {}),
    },
  )

export const apiPayRenew = (token: string, plan: 'month' | 'year') =>
  call<{ payment: PaymentInfo }>('/api/pay/renew', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ plan }),
  })

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
