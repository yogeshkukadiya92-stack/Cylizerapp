import type { ApiErrorCode, ApiErrorDetail } from "@callora/contracts";

export class ApiDomainError extends Error {
  readonly statusCode: number;
  readonly code: ApiErrorCode;
  readonly details?: ApiErrorDetail[];
  readonly retryAfterSeconds?: number;

  constructor(options: {
    statusCode: number;
    code: ApiErrorCode;
    message: string;
    details?: ApiErrorDetail[];
    retryAfterSeconds?: number;
  }) {
    super(options.message);
    this.name = "ApiDomainError";
    this.statusCode = options.statusCode;
    this.code = options.code;
    if (options.details !== undefined) {
      this.details = options.details;
    }
    if (options.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
  }
}

export function badRequest(message: string, field?: string): ApiDomainError {
  return new ApiDomainError({
    statusCode: 400,
    code: "VALIDATION_FAILED",
    message,
    ...(field === undefined
      ? {}
      : { details: [{ field, code: "INVALID", message }] }),
  });
}

export function unauthenticated(message = "Authentication is required"): ApiDomainError {
  return new ApiDomainError({ statusCode: 401, code: "UNAUTHENTICATED", message });
}

export function forbidden(message = "You do not have permission to perform this action"): ApiDomainError {
  return new ApiDomainError({ statusCode: 403, code: "FORBIDDEN", message });
}

export function notFound(message: string): ApiDomainError {
  return new ApiDomainError({ statusCode: 404, code: "NOT_FOUND", message });
}

export function conflict(message: string): ApiDomainError {
  return new ApiDomainError({ statusCode: 409, code: "CONFLICT", message });
}

export function consentRequired(message = "Current collection-policy consent is required"): ApiDomainError {
  return new ApiDomainError({ statusCode: 409, code: "CONSENT_REQUIRED", message });
}
