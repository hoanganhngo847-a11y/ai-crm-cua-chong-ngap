import { APPLICATION_ROLES, type ApplicationRole } from '../constants/roles';

/**
 * Allowed purposes for accessing raw customer contact information.
 * Arbitrary string purposes are strictly forbidden.
 */
export const CONTACT_ACCESS_PURPOSES = {
  CLICK_TO_CALL: 'CLICK_TO_CALL',
  PRIVILEGED_ADMIN_OPERATION: 'PRIVILEGED_ADMIN_OPERATION',
} as const;

export type ContactAccessPurpose =
  (typeof CONTACT_ACCESS_PURPOSES)[keyof typeof CONTACT_ACCESS_PURPOSES];

/**
 * Allowed purposes for accessing raw interaction content.
 * Raw interaction access requires a specifically approved trusted-server purpose.
 */
export const RAW_INTERACTION_PURPOSES = {
  VOICE_TRANSCRIPTION: 'VOICE_TRANSCRIPTION',
  SANITIZATION_PIPELINE: 'SANITIZATION_PIPELINE',
  PRIVILEGED_AUDIT: 'PRIVILEGED_AUDIT',
} as const;

export type RawInteractionPurpose =
  (typeof RAW_INTERACTION_PURPOSES)[keyof typeof RAW_INTERACTION_PURPOSES];

/**
 * Frozen human-role policy for VERBATIM call transcripts.
 * Authorized strictly for BOSS_ADMIN via audited trusted-server path.
 * Direct client SELECT, SALE, and TECHNICIAN access are strictly denied.
 */
export const VERBATIM_TRANSCRIPT_ALLOWED_ROLES = [APPLICATION_ROLES.BOSS_ADMIN] as const;

/**
 * Verbatim call transcript DTO returned to authorized BOSS_ADMIN.
 * Contains original speech text and speaker timestamps.
 * Never exposed to SALE or TECHNICIAN.
 */
export interface CallTranscriptDTO {
  id: string;
  companyId: string;
  callId: string;
  transcript: string;
  speakers: unknown;
  processedAt: string;
  language: string;
  createdAt: string;
}

/**
 * Click-to-call browser request parameters.
 * Browser input must contain identifiers ONLY. Never phone!
 */
export interface ClickToCallParams {
  customerId: string;
  interactionId?: string;
}

/**
 * Safe Click-to-call response returned to browser.
 * Must NEVER contain raw phone, normalized phone, token, or provider secrets/correlation IDs.
 */
export interface ClickToCallResult {
  success: boolean;
  callId: string;
  status: string;
}

/**
 * Clean telephony PBX provider interface.
 */
export interface CallProvider {
  name: string;
  initiateCall(params: {
    fromStaffUserId: string;
    targetRawPhone: string;
    customerId: string;
    companyId: string;
  }): Promise<{
    providerCallId: string;
    status: string;
  }>;
}

/**
 * Frozen signed URL resource categories and TTL values (in seconds).
 * See docs/SUPABASE_RLS_DESIGN.md (Storage Decision 01 & Section 11).
 *
 * survey/install files: 3600 seconds
 * contracts: 1800 seconds
 * recordings: 900 seconds
 */
export const SIGNED_URL_TTL = {
  SURVEY: 3600,
  INSTALLATION: 3600,
  CONTRACT: 1800,
  RECORDING: 900,
} as const;

export type SignedUrlResourceCategory = keyof typeof SIGNED_URL_TTL;

/**
 * Storage bucket names mapping per STORAGE DECISION 01.
 * The canonical installation bucket is `installation-docs`.
 */
export const STORAGE_BUCKET_MAP: Record<SignedUrlResourceCategory, string> = {
  SURVEY: 'survey-photos',
  INSTALLATION: 'installation-docs',
  CONTRACT: 'contracts',
  RECORDING: 'call-recordings',
};

/**
 * Strongly-typed signed URL request.
 * SECURITY INVARIANT: Arbitrary client-controlled fileRef or paths are STRICTLY PROHIBITED.
 * The client specifies ONLY the target resource and optional constrained slot/variant.
 * The server resolves the canonical file reference directly from the database row.
 */
export type SignedUrlRequest =
  | { category: 'SURVEY'; resourceId: string; photoIndex?: number }
  | { category: 'CONTRACT'; resourceId: string; variant?: 'generated' | 'signed' }
  | { category: 'RECORDING'; resourceId: string }
  | { category: 'INSTALLATION'; resourceId: string; variant: 'photo'; photoIndex: number }
  | { category: 'INSTALLATION'; resourceId: string; variant: 'handover' };

export interface SignedUrlResult {
  signedUrl: string;
  expiresIn: number;
}

/**
 * Customer private contact (server-internal only; never returned to browser).
 */
export interface CustomerPrivateContactInternal {
  customerId: string;
  companyId: string;
  rawPhone: string;
  normalizedPhone: string;
  isVerified: boolean;
}

/**
 * Safe sanitized interaction DTO for SALE / client exposure.
 */
export interface SanitizedInteractionDTO {
  id: string;
  companyId: string;
  customerId: string;
  conversationId: string | null;
  channel: string;
  type: string;
  direction: string;
  sanitizedContent: string | null;
  sanitizationStatus: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'NOT_REQUIRED';
  sanitizedAt: string | null;
  actorType: string;
  actorUserId: string | null;
  createdAt: string;
}

/**
 * Server-internal raw interaction content.
 */
export interface RawInteractionContentDTO {
  interactionId: string;
  companyId: string;
  rawContent: string;
  rawPayload: Record<string, unknown>;
  sourceMetadata: Record<string, unknown>;
  createdAt: string;
}

/**
 * Safe Staff Directory DTO (RLS DECISION 01).
 * Explicit allowlist: id, display_name, role, avatar_url.
 */
export interface SafeStaffMemberDTO {
  id: string;
  display_name: string;
  role: ApplicationRole;
  avatar_url: string | null;
}

/**
 * Technician assignment lifecycle statuses (FROZEN).
 */
export const TECHNICIAN_ASSIGNMENT_STATUSES = {
  ASSIGNED: 'ASSIGNED',
  ACCEPTED: 'ACCEPTED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  REJECTED: 'REJECTED',
  ACTIVE: ['ASSIGNED', 'ACCEPTED', 'IN_PROGRESS'] as const,
  INACTIVE: ['COMPLETED', 'CANCELLED', 'REJECTED'] as const,
} as const;
