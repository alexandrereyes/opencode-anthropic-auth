import { buildBillingHeaderValue } from './cch.ts'
import {
  CLAUDE_CODE_ENTRYPOINT,
  CLAUDE_CODE_IDENTITY,
  CLAUDE_CODE_VERSION,
  formatUserAgent,
  OPENCODE_IDENTITY_PREFIX,
  PARAGRAPH_REMOVAL_ANCHORS,
  REQUIRED_BETAS,
  TEXT_REPLACEMENTS,
  TOOL_PREFIX,
} from './constants.ts'

// Bound an incomplete SSE line so malformed streams cannot grow memory forever.
export const MAX_SSE_LINE_BYTES = 5 * 1024 * 1024

function headersAfterBodyTransform(source: Headers): Headers {
  const headers = new Headers(source)
  for (const name of [
    'content-digest',
    'content-encoding',
    'content-length',
    'content-md5',
    'content-range',
    'digest',
    'etag',
  ]) {
    headers.delete(name)
  }
  return headers
}

type JsonToolNameState =
  | 'after-colon'
  | 'after-name-key'
  | 'key-candidate'
  | 'outside'
  | 'prefix-candidate'
  | 'string'
  | 'tool-name-candidate'

const JSON_NAME_KEY_SUFFIX = new TextEncoder().encode('name"')
const JSON_TOOL_PREFIX = new TextEncoder().encode(TOOL_PREFIX)
const UTF8_ENCODER = new TextEncoder()
const UTF8_FATAL_DECODER = new TextDecoder('utf-8', { fatal: true })
export const MAX_JSON_TOOL_NAME_BYTES = 1024

function isJsonWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d
}

/**
 * Rewrite JSON `name` string values without buffering the whole document.
 * Only a bounded tool-name candidate is retained across chunks; all document
 * content outside that string value is emitted immediately.
 */
function createJsonToolNameStream(
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  let state: JsonToolNameState = 'outside'
  let held: number[] = []
  let candidateIndex = 0
  let escaped = false

  const enterStringAfter = (byte: number) => {
    if (byte === 0x22) {
      state = 'outside'
      escaped = false
      return
    }
    state = 'string'
    escaped = byte === 0x5c
  }

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const output = new Uint8Array(chunk.byteLength + 32)
        let outputLength = 0
        const write = (byte: number) => {
          output[outputLength++] = byte
        }
        const enqueueOutput = () => {
          if (outputLength === 0) return
          controller.enqueue(output.slice(0, outputLength))
          outputLength = 0
        }
        const writeHeld = () => {
          for (const byte of held) write(byte)
          held = []
        }
        const processOutside = (byte: number) => {
          if (byte === 0x22) {
            held = [byte]
            candidateIndex = 0
            state = 'key-candidate'
            return
          }
          write(byte)
        }

        for (const byte of chunk) {
          if (state === 'outside') {
            processOutside(byte)
            continue
          }

          if (state === 'key-candidate') {
            if (byte === JSON_NAME_KEY_SUFFIX[candidateIndex]) {
              held.push(byte)
              candidateIndex++
              if (candidateIndex === JSON_NAME_KEY_SUFFIX.byteLength) {
                writeHeld()
                state = 'after-name-key'
              }
              continue
            }
            writeHeld()
            write(byte)
            enterStringAfter(byte)
            continue
          }

          if (state === 'string') {
            write(byte)
            if (escaped) {
              escaped = false
            } else if (byte === 0x5c) {
              escaped = true
            } else if (byte === 0x22) {
              state = 'outside'
            }
            continue
          }

          if (state === 'after-name-key') {
            if (isJsonWhitespace(byte)) {
              write(byte)
            } else if (byte === 0x3a) {
              write(byte)
              state = 'after-colon'
            } else {
              processOutside(byte)
            }
            continue
          }

          if (state === 'after-colon') {
            if (isJsonWhitespace(byte)) {
              write(byte)
            } else if (byte === 0x22) {
              write(byte)
              held = []
              candidateIndex = 0
              state = 'prefix-candidate'
            } else {
              processOutside(byte)
            }
            continue
          }

          if (state === 'prefix-candidate') {
            if (byte === JSON_TOOL_PREFIX[candidateIndex]) {
              held.push(byte)
              candidateIndex++
              if (candidateIndex === JSON_TOOL_PREFIX.byteLength) {
                held = []
                candidateIndex = 0
                escaped = false
                state = 'tool-name-candidate'
              }
              continue
            }
            writeHeld()
            write(byte)
            enterStringAfter(byte)
            continue
          }

          if (escaped) {
            held.push(byte)
            escaped = false
            if (held.length > MAX_JSON_TOOL_NAME_BYTES) {
              throw new Error(
                `JSON tool name exceeds ${MAX_JSON_TOOL_NAME_BYTES} byte limit`,
              )
            }
            continue
          }

          if (byte === 0x5c) {
            held.push(byte)
            escaped = true
            if (held.length > MAX_JSON_TOOL_NAME_BYTES) {
              throw new Error(
                `JSON tool name exceeds ${MAX_JSON_TOOL_NAME_BYTES} byte limit`,
              )
            }
            continue
          }

          if (byte === 0x22) {
            let replacement: Uint8Array
            if (held.length === 0) {
              replacement = JSON_TOOL_PREFIX
            } else {
              try {
                replacement = UTF8_ENCODER.encode(
                  unprefixName(
                    UTF8_FATAL_DECODER.decode(Uint8Array.from(held)),
                  ),
                )
              } catch {
                replacement = Uint8Array.from([...JSON_TOOL_PREFIX, ...held])
              }
            }
            enqueueOutput()
            controller.enqueue(replacement)
            write(byte)
            held = []
            candidateIndex = 0
            state = 'outside'
            continue
          }

          held.push(byte)
          if (held.length > MAX_JSON_TOOL_NAME_BYTES) {
            throw new Error(
              `JSON tool name exceeds ${MAX_JSON_TOOL_NAME_BYTES} byte limit`,
            )
          }
        }

        enqueueOutput()
      },
      flush(controller) {
        const trailing = Uint8Array.from(
          state === 'tool-name-candidate'
            ? [...JSON_TOOL_PREFIX, ...held]
            : held,
        )
        if (trailing.byteLength === 0) return
        controller.enqueue(trailing)
      },
    }),
  )
}

/**
 * Prefix a tool name with TOOL_PREFIX and uppercase the first character.
 * Claude Code uses PascalCase tool names (e.g. mcp_Bash, mcp_Read);
 * lowercase names (mcp_bash, mcp_read) are flagged as non-Claude-Code clients.
 */
function prefixName(name: string): string {
  return `${TOOL_PREFIX}${name.charAt(0).toUpperCase()}${name.slice(1)}`
}

/**
 * Reverse prefixName: strip TOOL_PREFIX and restore the original leading case.
 */
function unprefixName(name: string): string {
  // StructuredOutput is still used as StructuredOutput
  if (name === 'StructuredOutput') {
    return name
  }
  return `${name.charAt(0).toLowerCase()}${name.slice(1)}`
}

export type FetchInput = string | URL | Request

/**
 * Merge headers from a Request object and/or a RequestInit headers value
 * into a single Headers instance.
 */
export function mergeHeaders(input: FetchInput, init?: RequestInit): Headers {
  const headers = new Headers()

  if (input instanceof Request) {
    input.headers.forEach((value, key) => {
      headers.set(key, value)
    })
  }

  const initHeaders = init?.headers
  if (initHeaders) {
    if (initHeaders instanceof Headers) {
      initHeaders.forEach((value, key) => {
        headers.set(key, value)
      })
    } else if (Array.isArray(initHeaders)) {
      for (const entry of initHeaders) {
        const [key, value] = entry as [string, string]
        if (typeof value !== 'undefined') {
          headers.set(key, String(value))
        }
      }
    } else {
      for (const [key, value] of Object.entries(initHeaders)) {
        if (typeof value !== 'undefined') {
          headers.set(key, String(value))
        }
      }
    }
  }

  return headers
}

/**
 * Merge incoming beta headers with the required OAuth betas, deduplicating.
 */
export function mergeBetaHeaders(headers: Headers): string {
  const incomingBeta = headers.get('anthropic-beta') || ''
  const incomingBetasList = incomingBeta
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean)

  return [...new Set([...REQUIRED_BETAS, ...incomingBetasList])].join(',')
}

/**
 * Set OAuth-required headers on the request: authorization, beta, user-agent.
 * Removes x-api-key since we're using OAuth.
 *
 * `version` must be the same value passed to rewriteRequestBody for the same
 * request, otherwise the two reported versions disagree.
 */
export function setOAuthHeaders(
  headers: Headers,
  accessToken: string,
  version: string = CLAUDE_CODE_VERSION,
  cacheTtl?: '5m' | '1h',
): Headers {
  headers.set('authorization', `Bearer ${accessToken}`)
  headers.set('anthropic-beta', mergeBetaHeaders(headers))
  if (cacheTtl === '1h') {
    const betas = headers.get('anthropic-beta')?.split(',') ?? []
    headers.set(
      'anthropic-beta',
      [...new Set([...betas, 'extended-cache-ttl-2025-04-11'])].join(','),
    )
  }
  headers.set('user-agent', formatUserAgent(version))
  headers.delete('x-api-key')
  return headers
}

/**
 * Add TOOL_PREFIX to tool names in the request body.
 * Prefixes both tool definitions and tool_use blocks in messages.
 */
export function prefixToolNames(parsed: Record<string, unknown>): string {
  if (parsed.tools && Array.isArray(parsed.tools)) {
    parsed.tools = parsed.tools.map(
      (tool: { name?: string; [k: string]: unknown }) => ({
        ...tool,
        name: tool.name ? prefixName(tool.name) : tool.name,
      }),
    )
  }

  if (parsed.messages && Array.isArray(parsed.messages)) {
    parsed.messages = parsed.messages.map(
      (msg: {
        content?: Array<{
          type: string
          name?: string
          [k: string]: unknown
        }>
        [k: string]: unknown
      }) => {
        if (msg.content && Array.isArray(msg.content)) {
          msg.content = msg.content.map((block) => {
            if (block.type === 'tool_use' && block.name) {
              return { ...block, name: prefixName(block.name) }
            }
            return block
          })
        }
        return msg
      },
    )
  }

  return JSON.stringify(parsed)
}

/**
 * Strip TOOL_PREFIX from tool names in streaming response text.
 */
export function stripToolPrefix(text: string): string {
  return text.replace(
    /"name"\s*:\s*"mcp_([^"]+)"/g,
    (_match, name: string) => `"name": "${unprefixName(name)}"`,
  )
}

/**
 * Check if TLS verification should be skipped for custom API endpoints.
 * Only effective when ANTHROPIC_BASE_URL is also set.
 */
export function isInsecure(): boolean {
  if (!process.env.ANTHROPIC_BASE_URL?.trim()) return false
  const raw = process.env.ANTHROPIC_INSECURE?.trim()
  return raw === '1' || raw === 'true'
}

/**
 * Parse ANTHROPIC_BASE_URL from the environment.
 * Returns a valid HTTP(S) URL or null if unset/invalid.
 */
function resolveBaseUrl(): URL | null {
  const raw = process.env.ANTHROPIC_BASE_URL?.trim()
  if (!raw) return null
  try {
    const baseUrl = new URL(raw)
    if (
      (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') ||
      baseUrl.username ||
      baseUrl.password
    ) {
      return null
    }
    return baseUrl
  } catch {
    return null
  }
}

/**
 * Rewrite the request URL to add ?beta=true for /v1/messages requests.
 * When ANTHROPIC_BASE_URL is set, overrides the origin (protocol + host)
 * for all API requests flowing through the fetch wrapper.
 * Returns the modified input and URL (if applicable).
 */
export function rewriteUrl(input: FetchInput): {
  input: FetchInput
  url: URL | null
} {
  let requestUrl: URL | null = null
  try {
    if (typeof input === 'string' || input instanceof URL) {
      requestUrl = new URL(input.toString())
    } else if (input instanceof Request) {
      requestUrl = new URL(input.url)
    }
  } catch {
    requestUrl = null
  }

  if (!requestUrl) return { input, url: null }

  const originalHref = requestUrl.href

  const baseUrl = resolveBaseUrl()
  if (baseUrl) {
    requestUrl.protocol = baseUrl.protocol
    requestUrl.host = baseUrl.host
  }

  if (
    requestUrl.pathname === '/v1/messages' &&
    !requestUrl.searchParams.has('beta')
  ) {
    requestUrl.searchParams.set('beta', 'true')
  }

  if (requestUrl.href === originalHref) {
    return { input, url: requestUrl }
  }

  const newInput =
    input instanceof Request
      ? new Request(requestUrl.toString(), input)
      : requestUrl
  return { input: newInput, url: requestUrl }
}

/**
 * Sanitize OpenCode-branded strings from the system prompt text.
 *
 * 1. Removes the OPENCODE_IDENTITY paragraph.
 * 2. Removes any paragraph (text between blank lines) that contains
 *    one of the PARAGRAPH_REMOVAL_ANCHORS — typically URLs that
 *    identify OpenCode-specific content.
 * 3. Applies TEXT_REPLACEMENTS for inline occurrences of "OpenCode"
 *    inside paragraphs we want to keep.
 *
 * This approach is resilient to upstream rewording of the OpenCode
 * prompt — as long as the anchor strings (URLs, etc.) still appear
 * somewhere in the paragraph, the removal works.
 */
export function sanitizeSystemText(text: string): string {
  // Split into paragraphs (separated by one or more blank lines)
  const paragraphs = text.split(/\n\n+/)

  const filtered = paragraphs.filter((paragraph) => {
    if (paragraph.includes(OPENCODE_IDENTITY_PREFIX)) {
      // If the paragraph contains the identity, drop it entirely
      return false
    }

    // Remove paragraphs containing any removal anchor
    for (const anchor of PARAGRAPH_REMOVAL_ANCHORS) {
      if (paragraph.includes(anchor)) return false
    }

    return true
  })

  let result = filtered.join('\n\n')

  // Apply inline text replacements
  for (const rule of TEXT_REPLACEMENTS) {
    result = result.replace(rule.match, rule.replacement)
  }

  return result.trim()
}

type SystemBlock = { type: string; text: string; [k: string]: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Sanitize system prompt and prepend Claude Code identity.
 * Handles all Anthropic API system formats: undefined, string, or array of text blocks.
 */
export function prependClaudeCodeIdentity(system: unknown): SystemBlock[] {
  const identityBlock: SystemBlock = {
    type: 'text',
    text: CLAUDE_CODE_IDENTITY,
  }

  if (system == null) return [identityBlock]

  if (typeof system === 'string') {
    const sanitized = sanitizeSystemText(system)
    if (sanitized === CLAUDE_CODE_IDENTITY) return [identityBlock]
    return [identityBlock, { type: 'text', text: sanitized }]
  }

  if (isRecord(system)) {
    const type = typeof system.type === 'string' ? system.type : 'text'
    const text = typeof system.text === 'string' ? system.text : ''
    return [identityBlock, { ...system, type, text: sanitizeSystemText(text) }]
  }

  if (!Array.isArray(system)) return [identityBlock]

  const sanitized: SystemBlock[] = system.map((item: unknown) => {
    if (typeof item === 'string') {
      return { type: 'text', text: sanitizeSystemText(item) }
    }

    if (
      isRecord(item) &&
      item.type === 'text' &&
      typeof item.text === 'string'
    ) {
      return {
        ...item,
        type: 'text',
        text: sanitizeSystemText(item.text),
      }
    }

    return { type: 'text', text: String(item) }
  })

  // Idempotency: don't double-prepend if first block already has the identity
  if (sanitized[0]?.text === CLAUDE_CODE_IDENTITY) {
    return sanitized
  }

  return [identityBlock, ...sanitized]
}

/**
 * Rewrite the full request body: sanitize system prompt and prefix tool names.
 *
 * `version` must be the same value passed to setOAuthHeaders for the same
 * request, otherwise the two reported versions disagree.
 */
export function rewriteRequestBody(
  body: string,
  version: string = CLAUDE_CODE_VERSION,
  cacheTtl?: '5m' | '1h',
): string {
  try {
    const parsed = JSON.parse(body)
    if (cacheTtl) {
      // Only rewrite API cache markers, never similarly named fields in tool
      // schemas or tool inputs. A uniform TTL preserves Anthropic's ordering rule.
      const mark = (value: unknown) => {
        if (!isRecord(value) || !isRecord(value.cache_control)) return
        if (value.cache_control.type === 'ephemeral') {
          value.cache_control.ttl = cacheTtl
        }
      }
      mark(parsed)
      if (Array.isArray(parsed.tools)) parsed.tools.forEach(mark)
      if (Array.isArray(parsed.system)) parsed.system.forEach(mark)
      if (Array.isArray(parsed.messages)) {
        for (const message of parsed.messages) {
          if (Array.isArray(message.content)) message.content.forEach(mark)
        }
      }
    }
    const billingHeader =
      Array.isArray(parsed.messages) &&
      parsed.messages.some(
        (message: { role?: string }) => message.role === 'user',
      )
        ? buildBillingHeaderValue(
            parsed.messages,
            version,
            CLAUDE_CODE_ENTRYPOINT,
          )
        : null

    // Sanitize system prompt and prepend Claude Code identity
    parsed.system = prependClaudeCodeIdentity(parsed.system)

    // Prepend the billing header as a separate system block so the
    // final layout is: [billing header, identity, ...rest]
    if (billingHeader && Array.isArray(parsed.system)) {
      parsed.system.unshift({ type: 'text', text: billingHeader })
    }

    return prefixToolNames(parsed)
  } catch {
    return body
  }
}

/**
 * Create a streaming response that strips the tool prefix from tool names.
 */
export function createStrippedStream(response: Response): Response {
  const mediaType = response.headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase()
  if (!response.body) return response
  if (mediaType === 'application/json' || mediaType?.endsWith('+json')) {
    const stream = createJsonToolNameStream(response.body)
    const headers = headersAfterBodyTransform(response.headers)
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
  if (mediaType !== 'text/event-stream') return response

  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = new Uint8Array(0)
  let pendingLength = 0

  const appendPending = (bytes: Uint8Array) => {
    const requiredLength = pendingLength + bytes.byteLength
    if (requiredLength > MAX_SSE_LINE_BYTES) {
      throw new Error(`SSE line exceeds ${MAX_SSE_LINE_BYTES} byte limit`)
    }

    if (requiredLength > pending.byteLength) {
      let capacity = Math.max(1024, pending.byteLength)
      while (capacity < requiredLength) {
        capacity = Math.min(MAX_SSE_LINE_BYTES, capacity * 2)
      }
      const expanded = new Uint8Array(capacity)
      expanded.set(pending.subarray(0, pendingLength))
      pending = expanded
    }

    pending.set(bytes, pendingLength)
    pendingLength = requiredLength
  }

  const stream = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        let lastLineBreak = -1
        let lineLength = pendingLength
        for (let index = 0; index < chunk.byteLength; index++) {
          if (chunk[index] === 0x0a || chunk[index] === 0x0d) {
            lastLineBreak = index
            lineLength = 0
          } else {
            lineLength++
            if (lineLength > MAX_SSE_LINE_BYTES) {
              throw new Error(
                `SSE line exceeds ${MAX_SSE_LINE_BYTES} byte limit`,
              )
            }
          }
        }

        if (lastLineBreak < 0) {
          appendPending(chunk)
          return
        }

        const completeLines =
          decoder.decode(pending.subarray(0, pendingLength), {
            stream: true,
          }) + decoder.decode(chunk.subarray(0, lastLineBreak + 1))

        pendingLength = 0
        appendPending(chunk.subarray(lastLineBreak + 1))
        controller.enqueue(encoder.encode(stripToolPrefix(completeLines)))
      },
      flush(controller) {
        const trailing = decoder.decode(pending.subarray(0, pendingLength))
        if (trailing) {
          controller.enqueue(encoder.encode(stripToolPrefix(trailing)))
        }
      },
    }),
  )

  const headers = headersAfterBodyTransform(response.headers)

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
