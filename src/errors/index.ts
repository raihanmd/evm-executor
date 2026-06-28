/**
 * Application error with an HTTP status code and public-facing message.
 * Stack traces are logged internally but never exposed to API responses.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly publicMessage: string;

  constructor(statusCode: number, publicMessage: string, internalMessage?: string) {
    super(internalMessage ?? publicMessage);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.publicMessage = publicMessage;
  }
}

/** 400 Bad Request */
export class ValidationError extends AppError {
  constructor(message: string) {
    super(400, message);
    this.name = "ValidationError";
  }
}

/** 401 Unauthorized */
export class AuthError extends AppError {
  constructor(message = "Unauthorized") {
    super(401, message);
    this.name = "AuthError";
  }
}

/** 403 Forbidden */
export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(403, message);
    this.name = "ForbiddenError";
  }
}

/** 404 Not Found */
export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(404, message);
    this.name = "NotFoundError";
  }
}

/** 409 Conflict */
export class ConflictError extends AppError {
  constructor(message = "Resource conflict") {
    super(409, message);
    this.name = "ConflictError";
  }
}

/** 429 Too Many Requests */
export class RateLimitError extends AppError {
  constructor(message = "Too many requests") {
    super(429, message);
    this.name = "RateLimitError";
  }
}

/** 500 Internal Server Error */
export class InternalError extends AppError {
  constructor(message = "Internal server error", internalMessage?: string) {
    super(500, message, internalMessage);
    this.name = "InternalError";
  }
}
