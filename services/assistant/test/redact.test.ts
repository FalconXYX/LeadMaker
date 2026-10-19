import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/log.ts';
import { secretValues } from '../src/llm/index.ts';
import { REDACTED, Redactor } from '../src/redact.ts';

describe('Redactor', () => {
  const configured = 'my-configured-secret-value';
  const r = new Redactor([configured]);

  it.each([
    [`key ${configured} here`, `key ${REDACTED} here`],
    ['google AIzaSyA1234567890abcdefghijklmnopqrstuv end', `google ${REDACTED} end`],
    ['anthropic sk-ant-api03-abcdefghijklmnop', `anthropic ${REDACTED}`],
    ['openai sk-abcdefghijklmnopqrstuvwxyz012345', `openai ${REDACTED}`],
    ['header x-goog-api-key: abc123def', `header x-goog-api-key: ${REDACTED}`],
    ['{"x-api-key":"abc123def"}', `{"x-api-key":"${REDACTED}"}`],
    ['Authorization: Bearer tok_123456', `Authorization: ${REDACTED}`],
    ['https://host/v1?key=abc123&alt=sse', `https://host/v1?key=${REDACTED}&alt=sse`],
  ])('%s', (input, want) => {
    expect(r.text(input)).toBe(want);
  });

  it('scrubs nested objects and errors', () => {
    const err = new Error(`failed with ${configured}`);
    expect(r.value({ a: [{ b: configured }], err })).toEqual({
      a: [{ b: REDACTED }], err: { type: 'Error', message: `failed with ${REDACTED}`, stack: expect.not.stringContaining(configured) },
    });
  });

  it('collects the configured keys (never short or empty ones)', () => {
    expect(secretValues({ GEMINI_API_KEY: 'AIza-long-enough', ANTHROPIC_API_KEY: '', LEADMAKER_LLM_API_KEY: 'short' } as NodeJS.ProcessEnv))
      .toEqual(['AIza-long-enough']);
  });

  it('the logger scrubs messages, objects and errors', () => {
    const lines: string[] = [];
    const log = createLogger('info', r, { write: (l: string) => void lines.push(l) } as never);
    log.info({ detail: `x ${configured}` }, `message ${configured}`);
    log.error({ err: new Error(`boom AIzaSyA1234567890abcdefghijklmnopqrstuv`) }, 'failed');
    const all = lines.join('\n');
    expect(all).not.toContain(configured);
    expect(all).not.toMatch(/AIza/);
    expect(all.match(/\[redacted\]/g)!.length).toBeGreaterThanOrEqual(3);
  });
});
