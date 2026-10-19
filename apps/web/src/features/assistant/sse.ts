// A small Server-Sent Events parser for fetch() bodies. EventSource cannot POST, so the assistant reads
// its stream with fetch + ReadableStream and parses it here. Follows the WHATWG event-stream rules that
// matter in practice: LF / CRLF / CR line endings (also split across chunks), multi-line `data:`,
// `:` comment lines (keep-alives), an optional single space after the colon, and UTF-8 split across chunks.

export interface SseMessage {
  /** The `event:` field; "message" when the server sent none. */
  event: string;
  /** The `data:` lines joined with "\n". */
  data: string;
  id?: string;
}

/**
 * Incremental parser: feed it decoded text in arbitrary chunks, get back the events completed so far.
 *   const p = createSseParser();
 *   p.push('event: token\ndata: {"te'); // []
 *   p.push('xt":"Hi"}\n\n');            // [{ event: 'token', data: '{"text":"Hi"}' }]
 */
export function createSseParser() {
  let buffer = '';
  // A chunk that ended in "\r" may be the first half of "\r\n": swallow a leading "\n" next time.
  let pendingCr = false;
  let event = '';
  let data: string[] = [];
  let id: string | undefined;

  function line(raw: string, out: SseMessage[]) {
    if (raw === '') {
      // Lenient on one point: a named event with no data line ("event: done\n\n") is still delivered.
      if (data.length > 0 || event) out.push({ event: event || 'message', data: data.join('\n'), ...(id !== undefined ? { id } : {}) });
      event = '';
      data = [];
      return;
    }
    if (raw.startsWith(':')) return; // comment / keep-alive
    const colon = raw.indexOf(':');
    const field = colon < 0 ? raw : raw.slice(0, colon);
    let value = colon < 0 ? '' : raw.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id' && !value.includes('\0')) id = value;
    // `retry` and unknown fields are ignored.
  }

  return {
    push(text: string): SseMessage[] {
      const out: SseMessage[] = [];
      if (pendingCr && text.startsWith('\n')) text = text.slice(1);
      pendingCr = false;
      buffer += text;
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        const ch = buffer[i];
        if (ch !== '\n' && ch !== '\r') continue;
        line(buffer.slice(start, i), out);
        if (ch === '\r') {
          if (i + 1 === buffer.length) pendingCr = true;
          else if (buffer[i + 1] === '\n') i++;
        }
        start = i + 1;
      }
      buffer = buffer.slice(start);
      return out;
    },
    /** End of stream: a trailing event without its blank line is discarded, per the spec. */
    end(): SseMessage[] {
      buffer = '';
      event = '';
      data = [];
      return [];
    },
  };
}

/** Reads a byte stream to completion, yielding each SSE message as soon as it is complete. */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield* parser.push(decoder.decode(value, { stream: true }));
    }
    yield* parser.push(decoder.decode());
    parser.end();
    finished = true;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // The consumer stopped early (break / throw): close the connection instead of leaving it open.
    if (!finished) await reader.cancel().catch(() => {});
  }
}
