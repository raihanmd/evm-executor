import type { ErrorHandler } from "hono";
import { AppError } from "../errors/index.ts";
import { getLogger } from "../logger/index.ts";

export const errorHandler: ErrorHandler = (err, c) => {
  const logger = getLogger();

  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error(
        { err, statusCode: err.statusCode },
        err.message || err.publicMessage,
      );
    } else {
      logger.warn(
        { err, statusCode: err.statusCode },
        err.message || err.publicMessage,
      );
    }

    return c.json(
      {
        success: false,
        message: err.publicMessage,
      },
      // Safe: all AppError subclasses use valid HTTP status codes (400-500)
      err.statusCode as Parameters<typeof c.json>[1],
    );
  }

  logger.error({ err, stack: err instanceof Error ? err.stack : undefined }, "Unhandled internal error");

  return c.json(
    {
      success: false,
      message: "Internal server error",
    },
    500,
  );
};
