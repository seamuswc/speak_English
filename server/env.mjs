// Minimal .env loader (zero-dependency). Imported first by app.mjs so that
// STRIPE_SECRET_KEY & friends are set before pay.mjs reads process.env.
// Lines: KEY=value, # comments, optional quotes. Existing env vars win.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

try {
  const file = join(dirname(fileURLToPath(import.meta.url)), '.env')
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
    if (!m || line.trimStart().startsWith('#')) continue
    const key = m[1]
    if (process.env[key] !== undefined) continue
    let val = m[2]
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    )
      val = val.slice(1, -1)
    process.env[key] = val
  }
} catch {
  // no .env file — rely on real environment variables
}
