import { describe, expect, mock, spyOn, test } from 'bun:test'
import { ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR } from '../config'
import { CLAUDE_CODE_VERSION } from '../constants'
import plugin from '../index'
import { RETRY_HEADER, type RetryEvent } from '../retry'

/** Restore the version override captured before a test mutated it. */
function restoreVersionOverride(original: string | undefined) {
  if (original === undefined) {
    delete process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR]
  } else {
    process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR] = original
  }
}

/**
 * Minimal mock of the OpenCode v2 promise plugin `Context`, covering only
 * the `integration` and `session` surfaces this plugin uses.
 */
function createMockContext() {
  const integrationMethods: Array<Record<string, unknown>> = []
  const sessionHooks = new Map<string, (event: any) => Promise<void> | void>()
  const ctx = {
    options: {} as Record<string, unknown>,
    integration: {
      transform: mock(async (cb: (draft: any) => void) => {
        const draft = {
          method: {
            update: mock((input: Record<string, unknown>) => {
              integrationMethods.push(input)
            }),
          },
        }
        cb(draft)
        return { dispose: mock(async () => {}) }
      }),
      connection: {
        active: mock(
          async (_id: string): Promise<{ id: string } | undefined> => undefined,
        ),
        resolve: mock(
          async (_connection: unknown): Promise<unknown> => undefined,
        ),
      },
    },
    session: {
      hook: mock(
        async (name: string, cb: (event: any) => Promise<void> | void) => {
          sessionHooks.set(name, cb)
          return { dispose: mock(async () => {}) }
        },
      ),
    },
  }

  return {
    ctx,
    integrationMethods,
    sessionHooks,
  }
}

describe('default export', () => {
  test('is a v2 plugin definition with an id and a setup function', () => {
    expect(plugin.id).toBe('ex-machina.anthropic-auth')
    expect(plugin.setup).toBeFunction()
  })
})

describe('OAuth reset retry hooks', () => {
  async function fixture(modelID = 'claude') {
    const result = createMockContext()
    const account = { id: 'account-a', access: 'access-a' }
    result.ctx.integration.connection.active.mockImplementation(async () => ({
      id: account.id,
    }))
    result.ctx.integration.connection.resolve.mockImplementation(async () => ({
      type: 'oauth',
      methodID: 'claude-max',
      access: account.access,
      refresh: 'refresh',
      expires: Date.now() + 3_600_000,
    }))
    await plugin.setup(result.ctx as any)
    const scope = {
      sessionID: 'session',
      agent: 'build',
      model: { providerID: 'anthropic', id: modelID },
    }
    const request = async () => {
      const input = {
        ...scope,
        request: new Request('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          body: JSON.stringify({ model: modelID, messages: [] }),
          headers: { [RETRY_HEADER]: 'must-not-be-sent' },
        }),
      }
      await result.sessionHooks.get('http.request')!(input)
      expect(input.request.headers.has(RETRY_HEADER)).toBeFalse()
      return input.request
    }
    const respond = async (
      request: Request,
      seconds = 18_000,
      status = 429,
    ) => {
      const input = {
        ...scope,
        request,
        response: new Response('{"error":{"message":"rate limit"}}', {
          status,
          headers: {
            'retry-after': String(seconds),
            'content-type': 'application/json',
          },
        }),
      }
      await result.sessionHooks.get('http.response')!(input)
      return input.response
    }
    const retry = async (
      request: Request,
      response: Response,
      delay = 900_000,
    ) => {
      // The native Effect HttpContext stores query parameters separately.
      const url = new URL(request.url)
      url.search = ''
      const input: RetryEvent = {
        ...scope,
        error: { type: 'provider.rate-limit', status: response.status },
        http: {
          url: url.toString(),
          status: response.status,
          headers: Object.fromEntries(response.headers),
        },
        decision: { retry: true, delay },
      }
      await result.sessionHooks.get('retry')!(input)
      return input.decision
    }
    return { ...result, account, scope, request, respond, retry }
  }

  test('uses the exact OAuth response reset through all three hooks', async () => {
    const f = await fixture()
    const request = await f.request()
    const response = await f.respond(request)
    expect(response.headers.has(RETRY_HEADER)).toBeTrue()
    expect(await response.text()).toBe('{"error":{"message":"rate limit"}}')
    const decision = await f.retry(request, response)
    expect(decision.retry && decision.delay).toBeGreaterThan(18_000_000)
  })

  test.each([
    'claude-sonnet-4-6',
    'claude-opus-4-6',
    'team-opus-router',
  ])('does not apply family snapshots to %s through the HTTP/retry hooks', async (modelID) => {
    const f = await fixture(modelID)
    const request = await f.request()
    for (const status of [
      undefined,
      'rejected',
      'allowed',
      'allowed_warning',
    ]) {
      const headers = new Headers({
        'retry-after': '10',
        'anthropic-ratelimit-unified-7d_opus-status': 'rejected',
        'anthropic-ratelimit-unified-7d_opus-reset': String(
          Math.floor(Date.now() / 1000) + 604_800,
        ),
        'anthropic-ratelimit-unified-7d_sonnet-status': 'rejected',
        'anthropic-ratelimit-unified-7d_sonnet-reset': String(
          Math.floor(Date.now() / 1000) + 604_800,
        ),
      })
      if (status) headers.set('anthropic-ratelimit-unified-status', status)
      const input = {
        ...f.scope,
        request,
        response: new Response(
          '{"error":{"type":"rate_limit_error","message":"Too many requests"}}',
          { status: 429, headers },
        ),
      }
      await f.sessionHooks.get('http.response')!(input)
      const decision = await f.retry(request, input.response, 2000)
      expect(decision.retry && decision.delay).toBeGreaterThan(10_000)
      expect(decision.retry && decision.delay).toBeLessThanOrEqual(11_000)
    }
  })

  test.each([
    'claude-sonnet-4-6',
    'custom-alias',
  ])('uses aggregate plan quota without Retry-After for %s through all three hooks', async (modelID) => {
    const f = await fixture(modelID)
    const request = await f.request()
    const now = Math.floor(Date.now() / 1000)
    const body = JSON.stringify({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: 'You have reached your usage limit.',
      },
      request_id: 'req_test',
    })
    const input = {
      ...f.scope,
      request,
      response: new Response(body, {
        status: 429,
        headers: {
          'content-type': 'application/json',
          date: new Date(now * 1000).toUTCString(),
          'x-should-retry': 'true',
          'anthropic-ratelimit-unified-status': 'rejected',
          'anthropic-ratelimit-unified-reset': String(now + 18_000),
          'anthropic-ratelimit-unified-representative-claim': 'five_hour',
          'anthropic-ratelimit-unified-5h-status': 'rejected',
          'anthropic-ratelimit-unified-5h-reset': String(now + 18_000),
          'anthropic-ratelimit-unified-5h-utilization': '1.0',
          'anthropic-ratelimit-unified-7d-status': 'allowed',
          'anthropic-ratelimit-unified-7d-reset': String(now + 604_800),
          'anthropic-ratelimit-unified-7d_opus-status': 'rejected',
          'anthropic-ratelimit-unified-7d_opus-reset': String(now + 604_800),
        },
      }),
    }
    await f.sessionHooks.get('http.response')!(input)
    expect(input.response.headers.has('retry-after')).toBeFalse()
    expect(await input.response.text()).toBe(body)
    const decision = await f.retry(request, input.response)
    expect(decision.retry && decision.delay).toBeGreaterThan(18_000_000)
    expect(decision.retry && decision.delay).toBeLessThanOrEqual(18_001_000)
  })

  test('isolates concurrent failures on the same session and account', async () => {
    const f = await fixture()
    const [a, b] = await Promise.all([f.request(), f.request()])
    const [long, short] = await Promise.all([
      f.respond(b, 36_000),
      f.respond(a, 18_000),
    ])
    const [first, second] = await Promise.all([
      f.retry(a, short),
      f.retry(b, long),
    ])
    expect(first.retry && first.delay).toBeGreaterThan(18_000_000)
    expect(first.retry && first.delay).toBeLessThan(18_002_000)
    expect(second.retry && second.delay).toBeGreaterThan(36_000_000)
  })

  test('ignores a previous account at response time and retry time', async () => {
    const f = await fixture()
    const request = await f.request()
    const response = await f.respond(request)
    f.account.id = 'account-b'
    f.account.access = 'access-b'
    expect(await f.retry(request, response)).toEqual({
      retry: true,
      delay: 900_000,
    })
    expect((await f.respond(request)).headers.has(RETRY_HEADER)).toBeFalse()
  })

  test('supports token refresh within the same connection', async () => {
    const f = await fixture()
    const request = await f.request()
    const response = await f.respond(request)
    f.account.access = 'rotated-access'
    const decision = await f.retry(request, response)
    expect(decision.retry && decision.delay).toBeGreaterThan(18_000_000)
  })

  test('retains the provider failure and native decision when credential lookup fails', async () => {
    const f = await fixture()
    const request = await f.request()
    const marked = await f.respond(request)
    f.ctx.integration.connection.resolve.mockImplementation(async () => {
      throw new Error('connection removed')
    })
    expect(await f.retry(request, marked)).toEqual({
      retry: true,
      delay: 900_000,
    })
    const unmarked = await f.respond(request)
    expect(unmarked.status).toBe(429)
    expect(unmarked.headers.has(RETRY_HEADER)).toBeFalse()
    expect(await unmarked.text()).toBe('{"error":{"message":"rate limit"}}')
  })

  test('does not resolve credentials or override old-host retry without HTTP metadata', async () => {
    const f = await fixture()
    const before = f.ctx.integration.connection.resolve.mock.calls.length
    const input = {
      ...f.scope,
      error: { type: 'provider.rate-limit', status: 429 },
      decision: { retry: true, delay: 2000 },
    }
    await f.sessionHooks.get('retry')!(input)
    expect(input.decision).toEqual({ retry: true, delay: 2000 })
    expect(f.ctx.integration.connection.resolve.mock.calls.length).toBe(before)
  })

  test('still loads OAuth when an older host rejects retry hook registration', async () => {
    const f = createMockContext()
    f.ctx.session.hook.mockImplementation(async (name, cb) => {
      if (name === 'retry') throw new Error('Unknown hook')
      f.sessionHooks.set(name, cb)
      return { dispose: mock(async () => {}) }
    })
    const warning = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await plugin.setup(f.ctx as any)
      expect(f.sessionHooks.has('http.request')).toBeTrue()
      expect(f.sessionHooks.has('http.response')).toBeTrue()
      expect(warning).toHaveBeenCalledTimes(1)
    } finally {
      warning.mockRestore()
    }
  })

  test('does not mark API-key, cancelled or non-429 responses', async () => {
    const f = await fixture()
    const apiKeyRequest = new Request('https://api.anthropic.com/v1/messages', {
      headers: { 'x-api-key': 'key' },
    })
    expect(
      (await f.respond(apiKeyRequest)).headers.has(RETRY_HEADER),
    ).toBeFalse()
    const request = await f.request()
    expect(
      (await f.respond(request, 18_000, 529)).headers.has(RETRY_HEADER),
    ).toBeFalse()
    const controller = new AbortController()
    const aborted = new Request(request, { signal: controller.signal })
    controller.abort()
    expect((await f.respond(aborted)).headers.has(RETRY_HEADER)).toBeFalse()
  })
})

describe('integration registration', () => {
  test('registers a Claude Pro/Max OAuth method on the anthropic integration', async () => {
    const { ctx, integrationMethods } = createMockContext()
    await plugin.setup(ctx as any)

    expect(integrationMethods).toHaveLength(1)
    const registration = integrationMethods[0]!
    expect(registration.integrationID).toBe('anthropic')
    expect(registration.method).toEqual({
      id: 'claude-max',
      type: 'oauth',
      label: 'Claude Pro/Max',
    })
    expect(registration.authorize).toBeFunction()
    expect(registration.refresh).toBeFunction()
  })

  test('authorize() returns a code-mode authorization pointing at claude.ai', async () => {
    const { ctx, integrationMethods } = createMockContext()
    await plugin.setup(ctx as any)

    const registration = integrationMethods[0] as any
    const authorization = await registration.authorize({})

    expect(authorization.mode).toBe('code')
    expect(authorization.instructions).toBeString()
    const url = new URL(authorization.url)
    expect(url.origin).toBe('https://claude.ai')
    expect(authorization.callback).toBeFunction()
  })

  test('authorize callback exchanges a valid code for a Credential.OAuth', async () => {
    const { ctx, integrationMethods } = createMockContext()

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            refresh_token: 'refresh-1',
            access_token: 'access-1',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch

    try {
      await plugin.setup(ctx as any)
      const registration = integrationMethods[0] as any
      const authorization = await registration.authorize({})

      const credential = await authorization.callback(
        `somecode#${new URL(authorization.url).searchParams.get('state')}`,
      )

      expect(credential.type).toBe('oauth')
      expect(credential.methodID).toBe('claude-max')
      expect(credential.access).toBe('access-1')
      expect(credential.refresh).toBe('refresh-1')
      expect(credential.expires).toBeGreaterThan(Date.now())
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('authorize callback throws on a failed exchange (invalid code)', async () => {
    const { ctx, integrationMethods } = createMockContext()
    await plugin.setup(ctx as any)

    const registration = integrationMethods[0] as any
    const authorization = await registration.authorize({})

    await expect(
      authorization.callback('not-a-valid-callback'),
    ).rejects.toThrow(/Failed to exchange/)
  })

  test('refresh() exchanges the refresh token for a rotated Credential.OAuth', async () => {
    const { ctx, integrationMethods } = createMockContext()

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock((_input: any, init: any) => {
      const body = JSON.parse(init.body)
      expect(body.grant_type).toBe('refresh_token')
      expect(body.refresh_token).toBe('old-refresh')
      return Promise.resolve(
        new Response(
          JSON.stringify({
            refresh_token: 'new-refresh',
            access_token: 'new-access',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
    }) as unknown as typeof fetch

    try {
      await plugin.setup(ctx as any)
      const registration = integrationMethods[0] as any

      const rotated = await registration.refresh({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'old-refresh',
        access: 'old-access',
        expires: Date.now() - 1000,
      })

      expect(rotated).toEqual({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'new-refresh',
        access: 'new-access',
        expires: rotated.expires,
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('refresh() throws a descriptive error on failure', async () => {
    const { ctx, integrationMethods } = createMockContext()

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('Forbidden', { status: 403 })),
    ) as unknown as typeof fetch

    try {
      await plugin.setup(ctx as any)
      const registration = integrationMethods[0] as any

      await expect(
        registration.refresh({
          type: 'oauth',
          methodID: 'claude-max',
          refresh: 'old-refresh',
          access: 'old-access',
          expires: Date.now() - 1000,
        }),
      ).rejects.toThrow('Anthropic token refresh failed: 403')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('concurrent refresh() calls deduplicate to a single token request', async () => {
    const { ctx, integrationMethods } = createMockContext()

    let tokenRequests = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(() => {
      tokenRequests++
      return Promise.resolve(
        new Response(
          JSON.stringify({
            refresh_token: 'new-refresh',
            access_token: 'new-access',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
    }) as unknown as typeof fetch

    try {
      await plugin.setup(ctx as any)
      const registration = integrationMethods[0] as any
      const credential = {
        type: 'oauth' as const,
        methodID: 'claude-max',
        refresh: 'old-refresh',
        access: 'old-access',
        expires: Date.now() - 1000,
      }

      const results = await Promise.all(
        Array.from({ length: 5 }, () => registration.refresh(credential)),
      )

      expect(tokenRequests).toBe(1)
      for (const result of results) {
        expect(result.access).toBe('new-access')
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('reuses a successful refresh for delayed calls with the rotated token', async () => {
    const { ctx, integrationMethods } = createMockContext()

    let tokenRequests = 0
    const originalFetch = globalThis.fetch
    let expireCachedRefresh: (() => void) | undefined
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: () => void,
      delay: number,
    ) => {
      if (delay === 30_000) expireCachedRefresh = handler
      return { unref() {} }
    }) as unknown as typeof setTimeout)
    globalThis.fetch = mock(() => {
      tokenRequests++
      return Promise.resolve(
        Response.json({
          refresh_token: 'new-refresh',
          access_token: 'new-access',
          expires_in: 3600,
        }),
      )
    }) as unknown as typeof fetch

    try {
      await plugin.setup(ctx as any)
      const registration = integrationMethods[0] as any
      const credential = {
        type: 'oauth' as const,
        methodID: 'claude-max',
        refresh: 'old-refresh',
        access: 'old-access',
        expires: Date.now() - 1000,
      }

      const first = await registration.refresh(credential)
      const delayed = await registration.refresh(credential)

      expect(tokenRequests).toBe(1)
      expect(delayed).toEqual(first)

      expireCachedRefresh?.()
      await registration.refresh(credential)
      expect(tokenRequests).toBe(2)
    } finally {
      globalThis.fetch = originalFetch
      setTimeoutSpy.mockRestore()
    }
  })

  test('concurrent refreshes keep different credentials isolated', async () => {
    const { ctx, integrationMethods } = createMockContext()
    const refreshTokens: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock((_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      const refreshToken = String(body.refresh_token)
      refreshTokens.push(refreshToken)
      return Promise.resolve(
        Response.json({
          refresh_token: `new-${refreshToken}`,
          access_token: `access-${refreshToken}`,
          expires_in: 3600,
        }),
      )
    }) as unknown as typeof fetch

    try {
      await plugin.setup(ctx as any)
      const registration = integrationMethods[0] as any
      const credential = (refresh: string) => ({
        type: 'oauth' as const,
        methodID: 'claude-max',
        refresh,
        access: 'old-access',
        expires: Date.now() - 1000,
      })

      const [first, second] = await Promise.all([
        registration.refresh(credential('first')),
        registration.refresh(credential('second')),
      ])

      expect(refreshTokens.toSorted()).toEqual(['first', 'second'])
      expect(first.access).toBe('access-first')
      expect(second.access).toBe('access-second')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('session http.request hook', () => {
  function anthropicOAuthContext() {
    const mocked = createMockContext()
    ;(mocked.ctx.integration.connection.active as any).mockImplementation(
      async () => ({ id: 'conn-1' }),
    )
    ;(mocked.ctx.integration.connection.resolve as any).mockImplementation(
      async () => ({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'r',
        access: 'my-access-token',
        expires: Date.now() + 100000,
      }),
    )
    return mocked
  }

  test.each([
    ['primary', undefined, undefined],
    ['primary', '1h', '1h'],
    ['primary', '5m', '5m'],
    ['title', '1h', undefined],
    ['compaction', '1h', undefined],
    ['generate', '1h', undefined],
  ])('cache TTL for %s with option %s', async (kind, option, expected) => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    ctx.options.promptCacheTtl = option
    await plugin.setup(ctx as any)
    const marker = { type: 'ephemeral' }
    const body = {
      tools: [
        {
          name: 'read',
          cache_control: marker,
          input_schema: { type: 'object' },
        },
      ],
      system: [
        { type: 'text', text: 'Stable instructions', cache_control: marker },
      ],
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Hello', cache_control: marker }],
        },
      ],
    }
    const event = {
      kind,
      model: { providerID: 'anthropic', id: 'claude-fable-5-1' },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'anthropic-beta': 'existing-beta' },
        body: JSON.stringify(body),
      }),
    }
    await sessionHooks.get('http.request')!(event)
    const result = JSON.parse(await event.request.text())
    const wanted = expected ? { type: 'ephemeral', ttl: expected } : marker
    expect(result.tools[0].cache_control).toEqual(wanted)
    expect(result.system.at(-1).cache_control).toEqual(wanted)
    expect(result.messages[0].content[0].cache_control).toEqual(wanted)
    expect(result.system[0].cache_control).toBeUndefined()
    expect(event.request.headers.get('anthropic-beta')).toContain(
      'existing-beta',
    )
    expect(
      event.request.headers
        .get('anthropic-beta')
        ?.includes('extended-cache-ttl-2025-04-11'),
    ).toBe(expected === '1h')
  })

  test('rejects an unsupported TTL at plugin setup', async () => {
    const { ctx } = createMockContext()
    ctx.options.promptCacheTtl = 'forever'
    await expect(plugin.setup(ctx as any)).rejects.toThrow('promptCacheTtl')
  })

  test('ignores non-anthropic providers', async () => {
    const { ctx, sessionHooks } = createMockContext()
    await plugin.setup(ctx as any)

    const originalRequest = new Request('https://api.openai.com/v1/chat', {
      method: 'POST',
      body: '{}',
    })
    const event: any = {
      model: { providerID: 'openai', modelID: 'gpt' },
      request: originalRequest,
    }
    await sessionHooks.get('http.request')!(event)

    expect(event.request).toBe(originalRequest)
  })

  test('leaves API-key Anthropic requests untouched', async () => {
    const { ctx, sessionHooks } = createMockContext()
    ctx.options.promptCacheTtl = '1h'
    await plugin.setup(ctx as any)

    const originalRequest = new Request(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        body: '{}',
      },
    )
    const event: any = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: originalRequest,
    }
    await sessionHooks.get('http.request')!(event)

    expect(event.request).toBe(originalRequest)
  })

  test('rewrites headers, body, and URL for an active OAuth connection', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx as any)

    const body = JSON.stringify({
      tools: [{ name: 'bash', type: 'function' }],
      messages: [{ role: 'user', content: 'hello world test message' }],
      system: 'You are a helpful assistant.',
    })
    const originalRequest = new Request(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'content-length': String(body.length),
          'x-api-key': 'my-access-token',
        },
        body,
      },
    )
    const event: any = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: originalRequest,
    }
    await sessionHooks.get('http.request')!(event)

    expect(event.request).not.toBe(originalRequest)
    const rewritten: Request = event.request
    expect(rewritten.headers.get('authorization')).toBe(
      'Bearer my-access-token',
    )
    expect(rewritten.headers.get('x-api-key')).toBeNull()
    expect(rewritten.headers.get('content-length')).toBeNull()
    expect(rewritten.headers.get('anthropic-beta')).toContain(
      'oauth-2025-04-20',
    )
    expect(rewritten.url).toContain('beta=true')

    const parsedBody = JSON.parse(await rewritten.text())
    expect(parsedBody.tools[0].name).toBe('mcp_Bash')
    expect(parsedBody.system[1].text).toBe(
      "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
    )
  })

  test('uses one configured Claude Code version for headers and billing', async () => {
    const originalVersion = process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR]
    process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR] = '2.9.99'

    try {
      const { ctx, sessionHooks } = anthropicOAuthContext()
      await plugin.setup(ctx as any)
      process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR] = '3.0.0'

      const event: any = {
        model: { providerID: 'anthropic', modelID: 'claude-3' },
        request: new Request('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          body: JSON.stringify({
            messages: [{ role: 'user', content: 'hello world test message' }],
          }),
        }),
      }
      await sessionHooks.get('http.request')!(event)

      expect(event.request.headers.get('user-agent')).toBe(
        'claude-cli/2.9.99 (external, cli)',
      )
      const parsedBody = JSON.parse(await event.request.text())
      expect(parsedBody.system[0].text).toContain('cc_version=2.9.99.')
    } finally {
      restoreVersionOverride(originalVersion)
    }
  })

  test('logs and ignores a malformed Claude Code version', async () => {
    const originalVersion = process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR]
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR] = 'latest'

    try {
      const { ctx, sessionHooks } = anthropicOAuthContext()
      await plugin.setup(ctx as any)

      expect(consoleError).toHaveBeenCalledTimes(1)
      expect(String(consoleError.mock.calls[0]?.[0])).toContain(
        ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR,
      )

      const event: any = {
        model: { providerID: 'anthropic', modelID: 'claude-3' },
        request: new Request('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          body: '{}',
        }),
      }
      await sessionHooks.get('http.request')!(event)

      expect(event.request.headers.get('user-agent')).toBe(
        `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
      )
    } finally {
      consoleError.mockRestore()
      restoreVersionOverride(originalVersion)
    }
  })

  test('warns about an outdated version override but still reports it', async () => {
    const originalVersion = process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR]
    const consoleWarn = spyOn(console, 'warn').mockImplementation(() => {})
    process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR] = '2.1.99'

    try {
      const { ctx, sessionHooks } = anthropicOAuthContext()
      await plugin.setup(ctx as any)

      expect(consoleWarn).toHaveBeenCalledTimes(1)
      expect(String(consoleWarn.mock.calls[0]?.[0])).toContain(
        ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR,
      )

      const event: any = {
        model: { providerID: 'anthropic', modelID: 'claude-3' },
        request: new Request('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          body: '{}',
        }),
      }
      await sessionHooks.get('http.request')!(event)

      // An outdated override was set deliberately, so it is still reported.
      expect(event.request.headers.get('user-agent')).toBe(
        'claude-cli/2.1.99 (external, cli)',
      )
    } finally {
      consoleWarn.mockRestore()
      restoreVersionOverride(originalVersion)
    }
  })

  test('stays silent for an override at or above the bundled version', async () => {
    const originalVersion = process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR]
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    const consoleWarn = spyOn(console, 'warn').mockImplementation(() => {})
    process.env[ANTHROPIC_CLAUDE_CODE_VERSION_ENV_VAR] = CLAUDE_CODE_VERSION

    try {
      const { ctx } = anthropicOAuthContext()
      await plugin.setup(ctx as any)

      expect(consoleError).not.toHaveBeenCalled()
      expect(consoleWarn).not.toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
      consoleWarn.mockRestore()
      restoreVersionOverride(originalVersion)
    }
  })

  test('preserves GET requests without a body', async () => {
    const { ctx, sessionHooks } = anthropicOAuthContext()
    await plugin.setup(ctx as any)

    const originalRequest = new Request('https://api.anthropic.com/v1/models', {
      method: 'GET',
    })
    const event: any = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: originalRequest,
    }
    await sessionHooks.get('http.request')!(event)

    const rewritten: Request = event.request
    expect(rewritten.method).toBe('GET')
    expect(await rewritten.text()).toBe('')
  })
})

describe('session http.response hook', () => {
  test('strips tool prefixes when the matching request used OAuth', async () => {
    const { ctx, sessionHooks } = createMockContext()
    let oauthActive = true
    ;(ctx.integration.connection.active as any).mockImplementation(async () =>
      oauthActive ? { id: 'conn-1' } : undefined,
    )
    ;(ctx.integration.connection.resolve as any).mockImplementation(
      async () => ({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'r',
        access: 'a',
        expires: Date.now() + 100000,
      }),
    )
    await plugin.setup(ctx as any)

    const requestEvent: any = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: '{}',
      }),
    }
    await sessionHooks.get('http.request')!(requestEvent)
    oauthActive = false

    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"content_block":{"type":"tool_use","name":"mcp_bash"}}\n\n',
          ),
        )
        controller.close()
      },
    })
    const originalResponse = new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
    const event: any = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: requestEvent.request,
      response: originalResponse,
    }
    await sessionHooks.get('http.response')!(event)

    expect(event.response).not.toBe(originalResponse)
    const text = await event.response.text()
    expect(text).toContain('"name": "bash"')
    expect(text).not.toContain('mcp_bash')
  })

  test('strips tool prefixes after another hook clones the OAuth request', async () => {
    const { ctx, sessionHooks } = createMockContext()
    ;(ctx.integration.connection.active as any).mockImplementation(
      async () => ({
        id: 'conn-1',
      }),
    )
    ;(ctx.integration.connection.resolve as any).mockImplementation(
      async () => ({
        type: 'oauth',
        methodID: 'claude-max',
        refresh: 'r',
        access: 'a',
        expires: Date.now() + 100000,
      }),
    )
    await plugin.setup(ctx as any)

    const requestEvent: any = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: '{}',
      }),
    }
    await sessionHooks.get('http.request')!(requestEvent)

    const clonedRequest = new Request(requestEvent.request)
    const responseEvent: any = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: clonedRequest,
      response: new Response(
        'data: {"content_block":{"type":"tool_use","name":"mcp_bash"}}\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    }
    await sessionHooks.get('http.response')!(responseEvent)

    expect(await responseEvent.response.text()).toContain('"name": "bash"')
  })

  test('leaves non-anthropic responses untouched', async () => {
    const { ctx, sessionHooks } = createMockContext()
    await plugin.setup(ctx as any)

    const originalResponse = new Response(null, { status: 200 })
    const event: any = {
      model: { providerID: 'openai', modelID: 'gpt' },
      request: new Request('https://api.openai.com/v1/chat'),
      response: originalResponse,
    }
    await sessionHooks.get('http.response')!(event)

    expect(event.response).toBe(originalResponse)
  })

  test('leaves Anthropic responses untouched when the request did not use OAuth', async () => {
    const { ctx, sessionHooks } = createMockContext()
    await plugin.setup(ctx as any)

    const originalResponse = new Response('ok')
    const event: any = {
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      request: new Request('https://api.anthropic.com/v1/messages'),
      response: originalResponse,
    }
    await sessionHooks.get('http.response')!(event)

    expect(event.response).toBe(originalResponse)
  })
})
