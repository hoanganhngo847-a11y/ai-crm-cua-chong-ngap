import 'server-only';

/**
 * Stable, safe error codes for trusted server authorization and sensitive operations.
 * These codes do not expose internal database schemas, credentials, or private details.
 */
export const SERVER_AUTH_ERROR_CODES = {
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  USER_INACTIVE: 'USER_INACTIVE',
  MEMBERSHIP_INACTIVE: 'MEMBERSHIP_INACTIVE',
  NOT_A_MEMBER: 'NOT_A_MEMBER',
  ROLE_FORBIDDEN: 'ROLE_FORBIDDEN',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  RESOURCE_FORBIDDEN: 'RESOURCE_FORBIDDEN',
  MFA_REQUIRED: 'MFA_REQUIRED',
  SENSITIVE_OPERATION_FORBIDDEN: 'SENSITIVE_OPERATION_FORBIDDEN',
  PROVIDER_FAILURE: 'PROVIDER_FAILURE',
  INVALID_PURPOSE: 'INVALID_PURPOSE',
  SANITIZATION_INCOMPLETE: 'SANITIZATION_INCOMPLETE',
  ASSIGNMENT_INACTIVE: 'ASSIGNMENT_INACTIVE',
  AUDIT_WRITE_FAILED: 'AUDIT_WRITE_FAILED',
  CALL_PROVIDER_FAILURE: 'CALL_PROVIDER_FAILURE',
  CALL_PROVIDER_NOT_CONFIGURED: 'CALL_PROVIDER_NOT_CONFIGURED',
  SIGNED_URL_UNAVAILABLE: 'SIGNED_URL_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ServerAuthErrorCode =
  (typeof SERVER_AUTH_ERROR_CODES)[keyof typeof SERVER_AUTH_ERROR_CODES];

/**
 * Standardized ServerAuthError for all trusted authorization and sensitive operations.
 * Guarantees that sensitive data (phone, secrets, tokens) are never formatted into the message.
 */
export class ServerAuthError extends Error {
  readonly status: number;
  readonly code: ServerAuthErrorCode;

  constructor(message: string, status = 403, code: ServerAuthErrorCode = 'RESOURCE_FORBIDDEN') {
    super(message);
    this.name = 'ServerAuthError';
    this.status = status;
    this.code = code;

    // Maintain prototype chain
    Object.setPrototypeOf(this, ServerAuthError.prototype);
  }
}

export function isServerAuthError(error: unknown): error is ServerAuthError {
  return error instanceof ServerAuthError;
}
