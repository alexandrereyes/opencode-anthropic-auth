import { type Credential, Plugin } from '@opencode-ai/plugin'
import { authorize, exchange, refreshToken } from './auth.ts'
import { resolveClaudeCodeVersion } from './config.ts'
import { CLAUDE_CODE_VERSION, REQUIRED_BETAS } from './constants.ts'
import {
  createStrippedStream,
  isInsecure,
  mergeHeaders,
  rewriteRequestBody,
  rewriteUrl,
  setOAuthHeaders,
} from './transform.ts'

const PLUGIN_ID = 'ex-machina.anthropic-auth'
const INTEGRATION_ID = 'anthropic'
const REFRESH_CACHE_GRACE_MS = 30_000

// `methodID` is a branded `Integration.MethodID` at the type level (a
// compile-time-only tag — there's no runtime representation), so a plain
// string literal needs a cast to satisfy the branded field.
const METHOD_ID = 'claude-max' as Credential.OAuth['methodID']

function toCredential(exchanged: {
  refresh: string
  access: string
  expires: number
}): Credential.OAuth {
  return {
    type: 'oauth',
    methodID: METHOD_ID,
    refresh: exchanged.refresh,
    access: exchanged.access,
    expires: exchanged.expires,
  }
}

async function resolveActiveOAuth(
  ctx: Plugin.Context,
): Promise<Credential.OAuth | undefined> {
  const connection = await ctx.integration.connection.active(INTEGRATION_ID)
  if (!connection) return undefined

  const credential = await ctx.integration.connection.resolve(connection)
  if (credential?.type === 'oauth' && credential.methodID === METHOD_ID) {
    return credential
  }

  return undefined
}

function warnIfInsecureUnsupported() {
  if (!isInsecure()) return
  console.warn(
    '[ex-machina.anthropic-auth] ANTHROPIC_INSECURE is set, but OpenCode v2 ' +
      'plugin request hooks cannot disable TLS verification for a custom ' +
      'ANTHROPIC_BASE_URL endpoint. TLS verification remains enabled — ' +
      'requests to an untrusted/self-signed endpoint will fail.',
  )
}

function isTransformedOAuthRequest(request: Request): boolean {
  const betas = new Set(
    (request.headers.get('anthropic-beta') ?? '')
      .split(',')
      .map((beta) => beta.trim()),
  )
  return (
    request.headers.get('authorization')?.startsWith('Bearer ') === true &&
    REQUIRED_BETAS.every((beta) => betas.has(beta)) &&
    new URL(request.url).searchParams.get('beta') === 'true'
  )
}

export default Plugin.define({
  id: PLUGIN_ID,
  setup: async (ctx) => {
    const promptCacheTtl = ctx.options.promptCacheTtl
    if (
      promptCacheTtl !== undefined &&
      promptCacheTtl !== '5m' &&
      promptCacheTtl !== '1h'
    ) {
      throw new Error('promptCacheTtl must be "5m" or "1h"')
    }
    warnIfInsecureUnsupported()
    // Resolved once per plugin instance so every request reports the same
    // version in both the user-agent and the billing header.
    const versionResolution = resolveClaudeCodeVersion()
    if (versionResolution.type === 'invalid') {
      console.error(`[ex-machina.anthropic-auth] ${versionResolution.error}`)
    } else if (versionResolution.type === 'outdated') {
      console.warn(`[ex-machina.anthropic-auth] ${versionResolution.warning}`)
    }
    // Only a malformed override lacks a usable version; an outdated one was
    // set deliberately, so it is reported as configured.
    const claudeCodeVersion =
      versionResolution.type === 'invalid'
        ? CLAUDE_CODE_VERSION
        : versionResolution.version

    // Retain successful refreshes for this plugin generation so a host call
    // holding the rotated token cannot submit it again before persistence.
    const refreshInFlight = new Map<string, Promise<Credential.OAuth>>()
    const refreshCredential = async (credential: Credential.OAuth) => {
      const existing = refreshInFlight.get(credential.refresh)
      if (existing) return existing

      const pending = (async () => {
        const result = await refreshToken(credential.refresh)
        if (result.type === 'failed') {
          throw new Error(`Anthropic token refresh failed: ${result.status}`)
        }
        return toCredential(result)
      })()
      refreshInFlight.set(credential.refresh, pending)
      try {
        const rotated = await pending
        const timer = setTimeout(() => {
          if (refreshInFlight.get(credential.refresh) === pending) {
            refreshInFlight.delete(credential.refresh)
          }
        }, REFRESH_CACHE_GRACE_MS)
        timer.unref?.()
        return rotated
      } catch (error) {
        if (refreshInFlight.get(credential.refresh) === pending) {
          refreshInFlight.delete(credential.refresh)
        }
        throw error
      }
    }

    await ctx.integration.transform((draft) => {
      draft.method.update({
        integrationID: INTEGRATION_ID,
        method: {
          id: METHOD_ID,
          type: 'oauth',
          label: 'Claude Pro/Max',
        },
        authorize: async () => {
          const result = await authorize('max')
          return {
            url: result.url,
            instructions: 'Paste the authorization code here:',
            mode: 'code',
            callback: async (code: string) => {
              const exchanged = await exchange(
                code,
                result.verifier,
                result.redirectUri,
                result.state,
              )
              if (exchanged.type === 'failed') {
                throw new Error(
                  'Failed to exchange the Claude Pro/Max authorization code. ' +
                    'Double-check that you pasted the full code and try again.',
                )
              }
              return toCredential(exchanged)
            },
          }
        },
        refresh: refreshCredential,
      })
    })

    await ctx.session.hook('http.request', async (event) => {
      if (event.model.providerID !== INTEGRATION_ID) return
      const credential = await resolveActiveOAuth(ctx)
      if (!credential) return

      const request = event.request
      const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
      const bodyText = hasBody ? await request.clone().text() : undefined
      const cacheTtl =
        'kind' in event && event.kind === 'primary' ? promptCacheTtl : undefined
      const rewrittenBody =
        bodyText !== undefined
          ? rewriteRequestBody(bodyText, claudeCodeVersion, cacheTtl)
          : undefined

      const headers = mergeHeaders(request)
      setOAuthHeaders(headers, credential.access, claudeCodeVersion, cacheTtl)
      if (rewrittenBody !== undefined) headers.delete('content-length')

      const { input: rewrittenInput } = rewriteUrl(request.url)
      const url =
        typeof rewrittenInput === 'string'
          ? rewrittenInput
          : rewrittenInput instanceof Request
            ? rewrittenInput.url
            : rewrittenInput.toString()

      event.request = new Request(url, {
        method: request.method,
        headers,
        body: rewrittenBody,
        signal: request.signal,
      })
    })

    await ctx.session.hook('http.response', (event) => {
      if (event.model.providerID !== INTEGRATION_ID) return
      if (!isTransformedOAuthRequest(event.request)) return
      event.response = createStrippedStream(event.response)
    })
  },
})
