import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Plugin } from '@opencode-ai/plugin'

// This header is added locally to responses, never to outgoing requests. Its
// MAC binds the deadline to one plugin instance, account and HTTP failure scope.
export const RETRY_HEADER = 'x-opencode-anthropic-oauth-retry'
const MAX_DELAY = 2_147_483_647
const GRACE_MS = 1_000

interface Scope {
  readonly sessionID: string
  readonly agent: string
  readonly model: {
    readonly providerID: string
    readonly id: string
    readonly variant?: string
  }
}

// Compatibility boundary for the pinned SDK, which predates the retry hook.
// Older hosts never call it, or omit http; both retain their native policy.
export interface RetryEvent extends Scope {
  readonly error: { readonly type: string; readonly status?: number }
  readonly http?: {
    readonly url: string
    readonly status: number
    readonly headers: Readonly<Record<string, string>>
  }
  decision: { retry: false } | { retry: true; delay: number }
}

export async function registerRetryHook(
  ctx: Plugin.Context,
  callback: (event: RetryEvent) => Promise<void>,
) {
  const hook = ctx.session.hook as unknown as (
    name: 'retry',
    callback: (event: RetryEvent) => Promise<void>,
  ) => Promise<unknown>
  try {
    await hook.call(ctx.session, 'retry', callback)
  } catch {
    // Optional extension: a host rejecting an unknown hook must still load OAuth.
    console.warn(
      '[ex-machina.anthropic-auth] Retry hook unavailable; using native retry policy.',
    )
  }
}

function timestamp(value: string | null): number | undefined {
  if (!value) return
  // Unified plan headers use epoch seconds; standard bucket headers use RFC3339.
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value) * 1_000
  const match =
    /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
      value,
    )
  if (!match) return
  const days = new Date(
    Date.UTC(Number(match[1]), Number(match[2]), 0),
  ).getUTCDate()
  if (Number(match[3]) < 1 || Number(match[3]) > days) return
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function httpDate(value: string | null): number | undefined {
  if (!value) return
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toUTCString() === value
    ? parsed
    : undefined
}

/** A future local deadline, based only on explicit evidence on this 429. */
export function resetDeadline(
  response: Response,
  now = Date.now(),
): number | undefined {
  if (response.status !== 429) return
  const headers = response.headers
  if (headers.get('x-should-retry')?.trim().toLowerCase() === 'false') return
  const reference = httpDate(headers.get('date')) ?? now
  const candidates: number[] = []
  const add = (deadline: number | undefined) => {
    if (deadline === undefined) return
    const delay = deadline - reference
    if (Number.isFinite(delay) && delay > 0 && delay <= MAX_DELAY - GRACE_MS) {
      candidates.push(now + delay + GRACE_MS)
    }
  }
  const after = headers.get('retry-after')
  add(
    after && /^\d+(?:\.\d+)?$/.test(after)
      ? reference + Number(after) * 1_000
      : httpDate(after),
  )
  const hasRetryAfter = candidates.length > 0

  // Only known shared plan windows are applicable independently of model IDs.
  // Catalog aliases do not prove the wire model family; model-specific and
  // unknown windows must rely on the provider's aggregate rejection/reset.
  // An explicit non-rejected aggregate wins over rejected window snapshots
  // (e.g. a short bucket 429 while the plan still permits this request).
  const overall = headers
    .get('anthropic-ratelimit-unified-status')
    ?.trim()
    .toLowerCase()
  if (overall === undefined || overall === 'rejected') {
    for (const window of ['', '-5h', '-7d']) {
      const prefix = `anthropic-ratelimit-unified${window}`
      if (headers.get(`${prefix}-status`)?.trim().toLowerCase() !== 'rejected')
        continue
      add(timestamp(headers.get(`${prefix}-reset`)))
    }
  }

  // Retry-After is the authoritative retry point for token buckets; their
  // reset means FULL replenishment, not necessarily the earliest valid retry.
  if (!hasRetryAfter) {
    for (const bucket of [
      'requests',
      'tokens',
      'input-tokens',
      'output-tokens',
    ]) {
      const prefix = `anthropic-ratelimit-${bucket}`
      if (headers.get(`${prefix}-remaining`) !== '0') continue
      const value = headers.get(`${prefix}-reset`)
      if (value?.includes('T')) add(timestamp(value))
    }
  }
  return candidates.length ? Math.ceil(Math.max(...candidates)) : undefined
}

export function createRetryBridge() {
  const key = randomBytes(32)
  // Effect's HttpContext URL can omit separately stored query parameters.
  // Bind the endpoint in both hooks, not the Web Request's serialized query.
  const endpoint = (url: string) => {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  }
  const sign = (deadline: number, scope: Scope, url: string, account: string) =>
    createHmac('sha256', key)
      .update(
        JSON.stringify([
          deadline,
          scope.sessionID,
          scope.agent,
          scope.model.providerID,
          scope.model.id,
          scope.model.variant ?? null,
          endpoint(url),
          account,
        ]),
      )
      .digest('hex')

  return {
    response(
      response: Response,
      scope: Scope,
      url: string,
      account?: string,
    ): Response {
      const deadline = account ? resetDeadline(response) : undefined
      if (deadline === undefined && !response.headers.has(RETRY_HEADER))
        return response
      const headers = new Headers(response.headers)
      // Never trust a marker supplied by an upstream server or another instance.
      headers.delete(RETRY_HEADER)
      if (deadline !== undefined && account) {
        headers.set(
          RETRY_HEADER,
          `${deadline}.${sign(deadline, scope, url, account)}`,
        )
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    },
    retry(event: RetryEvent, account: string, now = Date.now()) {
      if (
        event.model.providerID !== 'anthropic' ||
        event.http?.status !== 429 ||
        event.error.status !== 429 ||
        !URL.canParse(event.http.url) ||
        event.http.headers['x-should-retry']?.trim().toLowerCase() === 'false'
      )
        return
      if (
        event.error.type !== 'provider.rate-limit' &&
        event.error.type !== 'provider.quota'
      )
        return
      const marker = event.http.headers[RETRY_HEADER]
      const match = marker && /^(\d{13})\.([a-f0-9]{64})$/.exec(marker)
      if (!match?.[2]) return
      const deadline = Number(match[1])
      const delay = deadline - now
      if (delay <= 0 || delay > MAX_DELAY) return
      if (
        !timingSafeEqual(
          Buffer.from(match[2], 'hex'),
          Buffer.from(sign(deadline, event, event.http.url, account), 'hex'),
        )
      )
        return
      const nativeDelay =
        event.decision.retry && Number.isFinite(event.decision.delay)
          ? event.decision.delay
          : 0
      event.decision = { retry: true, delay: Math.max(delay, nativeDelay) }
    },
  }
}
