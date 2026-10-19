// Server-sent events parser shared by the providers' streaming responses (Gemini alt=sse, Anthropic, OpenAI).
// Handles \n, \r\n and \r line endings, multi-line data and chunk boundaries anywhere (even inside a UTF-8
// sequence: TextDecoder is used in streaming mode).

export interface SseFrame { event: string; data: string }

export async function* parseSse(body: AsyncIterable<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  let buf = '';
  let event = '';
  let data: string[] = [];
  const dispatch = (): SseFrame | null => {
    const frame = data.length ? { event: event || 'message', data: data.join('\n') } : null;
    event = '';
    data = [];
    return frame;
  };
  const lines = function* (final: boolean): Generator<string> {
    for (;;) {
      const m = /\r\n|\r|\n/.exec(buf);
      // A lone \r at the end may be the first half of \r\n: wait for the next chunk.
      if (!m || (m[0] === '\r' && m.index === buf.length - 1 && !final)) break;
      const line = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      yield line;
    }
    if (final && buf) {
      const rest = buf;
      buf = '';
      yield rest;
    }
  };
  const handle = (line: string): SseFrame | null => {
    if (line === '') return dispatch();
    if (line.startsWith(':')) return null;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    return null;
  };
  for await (const chunk of body) {
    if (signal?.aborted) return;
    buf += decoder.decode(chunk, { stream: true });
    for (const line of lines(false)) {
      const frame = handle(line);
      if (frame) yield frame;
    }
  }
  buf += decoder.decode();
  for (const line of lines(true)) {
    const frame = handle(line);
    if (frame) yield frame;
  }
  const last = dispatch();
  if (last) yield last;
}
