// Small helpers shared across route modules.

// Wrap an async route handler so thrown errors reach the Express error handler.
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

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
