export class HttpError extends Error {
  readonly status: number;
  readonly details?: unknown;
  readonly headers?: Record<string, string>;

  constructor(status: number, message: string, details?: unknown, headers?: Record<string, string>) {
    super(message);
    this.status = status;
    this.details = details;
    this.headers = headers;
  }
}

export const notFound = (what = 'lead') => new HttpError(404, `${what} not found`);
export const forbidden = (message = 'forbidden') => new HttpError(403, message);
export const badRequest = (message: string, details?: unknown) => new HttpError(400, message, details);
/** Overloaded (search queue full, or a statement hit its timeout): the client retries shortly. */
export const busy = () => new HttpError(503, 'busy', undefined, { 'Retry-After': '1' });
