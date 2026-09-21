// Small helpers shared across route modules.
import { z } from 'zod';

// Wrap an async route handler so thrown errors reach the Express error handler.
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// Every primary-key column in this app is a UUID (gen_random_uuid()), but a
// route handler that queries `WHERE id = $1` before checking that shape trips
// Postgres's own "invalid input syntax for type uuid" — an unhandled 500,
// logged with a full stack trace, for what is really just a bad URL (a typo,
// a stale link, or — as found in testing — a route ordering surprise like
// GET /export.csv falling through to GET /:id because /export.csv wasn't
// registered as its own path). Wire this into a router with
// `router.param('id', requireUuidParam)` once, and it's enforced for every
// route on that router using `:id`, however many there are.
export function requireUuidParam(req, _res, next, value) {
  if (!z.string().uuid().safeParse(value).success) {
    return next(new HttpError(400, `Invalid id`));
  }
  next();
}

// A tagged error carrying an HTTP status code.
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// Validate a request body/params against a zod schema, throwing 400 on failure.
export const parse = (schema, data) => {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new HttpError(400, 'Validation failed', result.error.flatten());
  }
  return result.data;
};
