import { describe, expect, test } from 'bun:test'
import {
  createRetryBridge,
  RETRY_HEADER,
  type RetryEvent,
  resetDeadline,
} from '../retry'

const now = Date.parse('2026-09-18T12:00:00Z')
const epoch = (seconds: number) => String(now / 1_000 + seconds)
const iso = (seconds: number) => new Date(now + seconds * 1_000).toISOString()
const response = (headers: Record<string, string>, status = 429) =>
  new Response('rate limited', { status, headers })

describe('Anthropic reset evidence', () => {
  test('uses the latest rejected window, ignoring healthy snapshots and overage', () => {
    expect(
      resetDeadline(
        response({
          'retry-after': '30',
          'Anthropic-Ratelimit-Unified-Status': 'rejected',
          'anthropic-ratelimit-unified-reset': epoch(3_600),
          'anthropic-ratelimit-unified-5h-status': 'rejected',
          'anthropic-ratelimit-unified-5h-reset': epoch(7_200),
          'anthropic-ratelimit-unified-7d-status': 'allowed',
          'anthropic-ratelimit-unified-7d-reset': epoch(604_800),
          'anthropic-ratelimit-unified-overage-status': 'rejected',
          'anthropic-ratelimit-unified-overage-reset': epoch(864_000),
        }),
        now,
      ),
    ).toBe(now + 7_201_000)
  })

  test.each([
    '5h',
    '7d',
  ])('recognizes rejected shared %s windows without aggregate status', (window) => {
    expect(
      resetDeadline(
        response({
          [`anthropic-ratelimit-unified-${window}-status`]: 'REJECTED',
          [`anthropic-ratelimit-unified-${window}-reset`]: epoch(18_000),
        }),
        now,
      ),
    ).toBe(now + 18_001_000)
  })

  test.each([
    '7d_opus',
    '7d_sonnet',
    '7d_oi',
    'future_window',
    'overage',
  ])('ignores unconfirmed %s windows even beside aggregate rejection', (window) => {
    const headers = {
      [`anthropic-ratelimit-unified-${window}-status`]: 'rejected',
      [`anthropic-ratelimit-unified-${window}-reset`]: epoch(604_800),
    }
    expect(resetDeadline(response(headers), now)).toBeUndefined()
    expect(
      resetDeadline(response({ ...headers, 'retry-after': '10' }), now),
    ).toBe(now + 11_000)
    expect(
      resetDeadline(
        response({
          ...headers,
          'anthropic-ratelimit-unified-status': 'rejected',
          'anthropic-ratelimit-unified-reset': epoch(18_000),
        }),
        now,
      ),
    ).toBe(now + 18_001_000)
  })

  test.each([
    'allowed',
    'allowed_warning',
    'unknown',
  ])('aggregate %s suppresses rejected snapshots on a bucket 429', (status) => {
    const headers = {
      'anthropic-ratelimit-unified-status': status,
      'anthropic-ratelimit-unified-reset': epoch(18_000),
      'anthropic-ratelimit-unified-5h-status': 'rejected',
      'anthropic-ratelimit-unified-5h-reset': epoch(18_000),
      'anthropic-ratelimit-unified-7d_opus-status': 'rejected',
      'anthropic-ratelimit-unified-7d_opus-reset': epoch(604_800),
      'anthropic-ratelimit-requests-remaining': '0',
      'anthropic-ratelimit-requests-reset': iso(60),
    }
    expect(resetDeadline(response(headers), now)).toBe(now + 61_000)
    expect(
      resetDeadline(response({ ...headers, 'retry-after': '10' }), now),
    ).toBe(now + 11_000)
  })

  test.each([
    'allowed',
    'allowed_warning',
    '',
    'unknown',
  ])('does not interpret %s as rejection', (status) => {
    expect(
      resetDeadline(
        response({
          'anthropic-ratelimit-unified-status': status,
          'anthropic-ratelimit-unified-reset': epoch(18_000),
        }),
        now,
      ),
    ).toBeUndefined()
  })

  test.each([
    'NaN',
    'Infinity',
    '-10',
    '1e12',
    '123abc',
    epoch(-1),
    String(now + 60_000),
    epoch(3_000_000),
    '2026-02-30T00:00:00Z',
  ])('ignores malformed, expired or unrepresentable reset %s', (value) => {
    expect(
      resetDeadline(
        response({
          'anthropic-ratelimit-unified-status': 'rejected',
          'anthropic-ratelimit-unified-reset': value,
        }),
        now,
      ),
    ).toBeUndefined()
  })

  test.each([
    200, 400, 401, 403, 408, 500, 529,
  ])('ignores reset headers on HTTP %s', (status) => {
    expect(
      resetDeadline(
        response(
          {
            'retry-after': '3600',
            'anthropic-ratelimit-unified-status': 'rejected',
            'anthropic-ratelimit-unified-reset': epoch(18_000),
          },
          status,
        ),
        now,
      ),
    ).toBeUndefined()
  })

  test('honors explicit retry veto', () => {
    expect(
      resetDeadline(
        response({ 'retry-after': '3600', 'x-should-retry': 'false' }),
        now,
      ),
    ).toBeUndefined()
  })

  test('supports Retry-After seconds and HTTP date without the native 15m cap', () => {
    for (const value of ['3600', new Date(now + 3_600_000).toUTCString()]) {
      expect(resetDeadline(response({ 'retry-after': value }), now)).toBe(
        now + 3_601_000,
      )
    }
  })

  test('accounts for server clock skew for absolute timestamps', () => {
    expect(
      resetDeadline(
        response({
          date: new Date(now - 120_000).toUTCString(),
          'anthropic-ratelimit-unified-status': 'rejected',
          'anthropic-ratelimit-unified-reset': epoch(60),
        }),
        now,
      ),
    ).toBe(now + 181_000)
  })

  test('uses exhausted RFC3339 buckets only as fallback to Retry-After', () => {
    const headers = {
      'anthropic-ratelimit-requests-remaining': '0',
      'anthropic-ratelimit-requests-reset': iso(60),
      'anthropic-ratelimit-input-tokens-remaining': '0',
      'anthropic-ratelimit-input-tokens-reset': iso(120),
      'anthropic-ratelimit-output-tokens-remaining': '1000',
      'anthropic-ratelimit-output-tokens-reset': iso(600),
    }
    expect(resetDeadline(response(headers), now)).toBe(now + 121_000)
    expect(
      resetDeadline(response({ ...headers, 'retry-after': '10' }), now),
    ).toBe(now + 11_000)
    expect(
      resetDeadline(
        response({ 'anthropic-ratelimit-requests-reset': iso(60) }),
        now,
      ),
    ).toBeUndefined()
  })
})

const scope = {
  sessionID: 'session-a',
  agent: 'build',
  model: { providerID: 'anthropic', id: 'claude' },
}
const url = 'https://api.anthropic.com/v1/messages?beta=true'
const event = (headers: Headers): RetryEvent => ({
  ...scope,
  error: { type: 'provider.rate-limit', status: 429 },
  http: { status: 429, url, headers: Object.fromEntries(headers) },
  decision: { retry: true, delay: 2_000 },
})

describe('response-local retry bridge', () => {
  test('keeps interleaved responses independent and uses absolute deadlines', () => {
    const bridge = createRetryBridge()
    const a = bridge.response(
      response({ 'retry-after': '3600' }),
      scope,
      url,
      'account-a',
    )
    const b = bridge.response(
      response({ 'retry-after': '7200' }),
      scope,
      url,
      'account-b',
    )
    const first = event(a.headers)
    const second = event(b.headers)
    const clock = Date.now()
    bridge.retry(second, 'account-b', clock)
    bridge.retry(first, 'account-a', clock)
    expect(first.decision.retry && first.decision.delay).toBeGreaterThan(
      3_600_000,
    )
    expect(second.decision.retry && second.decision.delay).toBeGreaterThan(
      7_200_000,
    )
    const later = event(a.headers)
    bridge.retry(later, 'account-a', clock + 10_000)
    expect(later.decision.retry && later.decision.delay).toBe(
      (first.decision.retry ? first.decision.delay : 0) - 10_000,
    )
  })

  test('rejects account, session, model, agent, URL and instance mismatches', () => {
    const bridge = createRetryBridge()
    const marked = bridge.response(
      response({ 'retry-after': '3600' }),
      scope,
      url,
      'account-a',
    )
    const inputs: RetryEvent[] = [
      { ...event(marked.headers), sessionID: 'other' },
      { ...event(marked.headers), agent: 'other' },
      { ...event(marked.headers), model: { ...scope.model, id: 'other' } },
      { ...event(marked.headers), model: { ...scope.model, variant: 'other' } },
      {
        ...event(marked.headers),
        http: {
          ...event(marked.headers).http!,
          url: 'https://api.anthropic.com/v1/other',
        },
      },
    ]
    for (const input of inputs) {
      bridge.retry(input, 'account-a')
      expect(input.decision).toEqual({ retry: true, delay: 2_000 })
    }
    const wrongAccount = event(marked.headers)
    bridge.retry(wrongAccount, 'account-b')
    expect(wrongAccount.decision).toEqual({ retry: true, delay: 2_000 })
    const otherInstance = event(marked.headers)
    createRetryBridge().retry(otherInstance, 'account-a')
    expect(otherInstance.decision).toEqual({ retry: true, delay: 2_000 })
  })

  test('removes upstream markers, preserves the error body, and does not expose account identity', async () => {
    const bridge = createRetryBridge()
    const fake = `${Date.now() + 3_600_000}.${'0'.repeat(64)}`
    const stripped = bridge.response(
      response({ [RETRY_HEADER]: fake }),
      scope,
      url,
    )
    expect(stripped.headers.has(RETRY_HEADER)).toBeFalse()
    expect(await stripped.text()).toBe('rate limited')
    const forged = event(new Headers({ [RETRY_HEADER]: fake }))
    bridge.retry(forged, 'secret-account-id')
    expect(forged.decision).toEqual({ retry: true, delay: 2_000 })
    const marked = bridge.response(
      response({ 'retry-after': '3600' }),
      scope,
      url,
      'secret-account-id',
    )
    expect(marked.headers.get(RETRY_HEADER)).not.toContain('secret-account-id')
  })

  test('falls back for absent metadata, expired markers and transport failures', () => {
    const bridge = createRetryBridge()
    const marked = bridge.response(
      response({ 'retry-after': '3600' }),
      scope,
      url,
      'account-a',
    )
    for (const input of [
      { ...event(marked.headers), http: undefined },
      {
        ...event(marked.headers),
        http: { ...event(marked.headers).http!, url: 'invalid' },
      },
      event(
        new Headers({
          ...Object.fromEntries(marked.headers),
          'x-should-retry': 'false',
        }),
      ),
      {
        ...event(marked.headers),
        error: { type: 'provider.transport', status: 429 },
      },
      event(new Headers()),
    ]) {
      bridge.retry(input, 'account-a')
      expect(input.decision).toEqual({ retry: true, delay: 2_000 })
    }
    const expired = event(marked.headers)
    bridge.retry(expired, 'account-a', Date.now() + 4_000_000)
    expect(expired.decision).toEqual({ retry: true, delay: 2_000 })
  })

  test('can make quota retryable without shortening a larger native delay', () => {
    const bridge = createRetryBridge()
    const marked = bridge.response(
      response({ 'retry-after': '3600' }),
      scope,
      url,
      'account-a',
    )
    const quota: RetryEvent = {
      ...event(marked.headers),
      error: { type: 'provider.quota', status: 429 },
      decision: { retry: false },
    }
    bridge.retry(quota, 'account-a')
    expect(quota.decision.retry && quota.decision.delay).toBeGreaterThan(
      3_600_000,
    )
    const longer: RetryEvent = {
      ...event(marked.headers),
      decision: { retry: true, delay: 8_000_000 },
    }
    bridge.retry(longer, 'account-a')
    expect(longer.decision).toEqual({ retry: true, delay: 8_000_000 })
  })
})
