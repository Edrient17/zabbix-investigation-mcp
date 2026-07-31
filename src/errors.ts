export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: {
      status?: number;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = options.status ?? 400;
    this.details = options.details;
  }
}

export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof Error) {
    return new AppError("INTERNAL_ERROR", "Unexpected internal error", {
      status: 500,
      cause: error,
    });
  }

  return new AppError("INTERNAL_ERROR", "Unexpected internal error", {
    status: 500,
  });
}

export function errorPayload(error: unknown): Record<string, unknown> {
  const normalized = normalizeError(error);
  return {
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.details ? { details: normalized.details } : {}),
    },
  };
}
