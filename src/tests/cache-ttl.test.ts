import { expect, test } from 'bun:test'
import { rewriteRequestBody, setOAuthHeaders } from '../transform'

test('changes only actual cache breakpoints and keeps the breakpoint count', () => {
  const nested = { cache_control: { type: 'ephemeral', ttl: '5m' } }
  const body = {
    cache_control: { type: 'ephemeral' },
    tools: [{ name: 'read', input_schema: nested }],
    system: [{ type: 'text', text: 'Stable instructions' }],
    messages: [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'id',
            name: 'read',
            input: nested,
            cache_control: { type: 'ephemeral', ttl: '5m' },
          },
        ],
      },
    ],
  }
  const result = JSON.parse(
    rewriteRequestBody(JSON.stringify(body), undefined, '1h'),
  )
  expect(result.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
  expect(result.messages[0].content[0].cache_control).toEqual({
    type: 'ephemeral',
    ttl: '1h',
  })
  expect(result.tools[0].input_schema).toEqual(nested)
  expect(result.messages[0].content[0].input).toEqual(nested)
  expect(result.tools[0].cache_control).toBeUndefined()
  expect(
    result.system.every(
      (block: { cache_control?: unknown }) => !block.cache_control,
    ),
  ).toBe(true)
})

test('the opt-out applies one TTL to all markers, including existing hour markers', () => {
  const body = {
    system: [
      {
        type: 'text',
        text: 'First',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
      {
        type: 'text',
        text: 'Second',
        cache_control: { type: 'ephemeral', ttl: '5m' },
      },
    ],
  }
  const result = JSON.parse(
    rewriteRequestBody(JSON.stringify(body), undefined, '5m'),
  )
  expect(
    result.system
      .filter((block: { cache_control?: unknown }) => block.cache_control)
      .map(
        (block: { cache_control: { ttl: string } }) => block.cache_control.ttl,
      ),
  ).toEqual(['5m', '5m'])
})

test('the extended TTL beta is not duplicated', () => {
  const headers = new Headers({
    'anthropic-beta': 'extended-cache-ttl-2025-04-11',
  })
  setOAuthHeaders(headers, 'test-token', undefined, '1h')
  expect(
    headers
      .get('anthropic-beta')
      ?.split(',')
      .filter((beta) => beta === 'extended-cache-ttl-2025-04-11'),
  ).toHaveLength(1)
})
