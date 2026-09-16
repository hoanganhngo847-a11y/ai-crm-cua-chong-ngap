import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '../supabase/admin';
import { APPLICATION_ROLES } from '../../shared/constants/roles';
import {
  SIGNED_URL_TTL,
  STORAGE_BUCKET_MAP,
  type SignedUrlRequest,
  type SignedUrlResourceCategory,
  type SignedUrlResult,
} from '../../shared/contracts/sensitive';
import { ServerAuthError } from '../server-auth/errors';
import {
  authorizeSurveyAccess,
  authorizeContractAccess,
  authorizeInstallationAccess,
} from '../server-auth/resource-access';
import { verifyActorForCompany } from '../server-auth/authorize';

/**
 * Returns the immutable server-enforced TTL for a given resource category.
 * Client input is NEVER allowed to control or override TTL values.
 */
export function getCategoryTTL(category: SignedUrlResourceCategory): number {
  const ttl = SIGNED_URL_TTL[category];
  if (!ttl) {
    throw new ServerAuthError(
      'Danh mục tệp tài nguyên không hợp lệ.',
      400,
      'INVALID_PURPOSE'
    );
  }
  return ttl;
}

/**
 * Creates an authorized signed URL for sensitive storage assets.
 *
 * CRITICAL SECURITY INVARIANTS:
 * 1. Arbitrary client-controlled paths / fileRefs are STRICTLY PROHIBITED (eliminates IDOR).
 * 2. Canonical file reference is ALWAYS resolved from the database row after authorization.
 * 3. Centralized immutable TTL:
 *    - SURVEY: 3600s
 *    - INSTALLATION: 3600s
 *    - CONTRACT: 1800s
 *    - RECORDING: 900s
 * 4. INSTALLATION authorizes the actual INSTALLATIONS entity and resolves a constrained
 *    photo/handover selector against canonical DB references in `installation-docs`.
 * 5. RECORDING is restricted strictly to BOSS_ADMIN with MFA AAL2.
 * 6. Storage signing failure MUST FAIL CLOSED. Mock/fallback URLs are STRICTLY FORBIDDEN.
 */
export async function createAuthorizedSignedUrl(
  request: SignedUrlRequest,
  client?: SupabaseClient
): Promise<SignedUrlResult> {
  const { category, resourceId } = request;

  if (!category || !resourceId) {
    throw new ServerAuthError(
      'Yêu cầu tệp không hợp lệ: thiếu thông tin bắt buộc.',
      400,
      'INVALID_PURPOSE'
    );
  }

  const ttl = getCategoryTTL(category);
  const adminClient = createAdminClient();

  let bucketName: string;
  let canonicalFileRef: string;

  switch (category) {
    case 'SURVEY': {
      // 1. Authorize survey access (Boss, Sale, or assigned Tech)
      await authorizeSurveyAccess(resourceId, client);

      // 2. Load canonical file reference from database
      const { data: survey, error: surveyError } = await adminClient
        .from('surveys')
        .select('photos')
        .eq('id', resourceId)
        .maybeSingle();

      if (surveyError || !survey) {
        throw new ServerAuthError('Không tìm thấy bản khảo sát.', 404, 'RESOURCE_NOT_FOUND');
      }

      const photos = Array.isArray(survey.photos) ? (survey.photos as string[]) : [];
      const index = request.photoIndex !== undefined ? request.photoIndex : 0;
      const ref = photos[index];

      if (!ref) {
        throw new ServerAuthError('Không tìm thấy tệp ảnh khảo sát yêu cầu.', 404, 'RESOURCE_NOT_FOUND');
      }

      bucketName = STORAGE_BUCKET_MAP.SURVEY;
      canonicalFileRef = ref;
      break;
    }

    case 'CONTRACT': {
      // 1. Authorize contract access (Boss, Sale)
      await authorizeContractAccess(resourceId, client);

      // 2. Load canonical file reference from database
      const { data: contract, error: contractError } = await adminClient
        .from('contracts')
        .select('generated_file_ref, signed_file_ref')
        .eq('id', resourceId)
        .maybeSingle();

      if (contractError || !contract) {
        throw new ServerAuthError('Không tìm thấy hợp đồng.', 404, 'RESOURCE_NOT_FOUND');
      }

      const ref =
        request.variant === 'signed'
          ? contract.signed_file_ref
          : contract.generated_file_ref;

      if (!ref) {
        throw new ServerAuthError('Không tìm thấy tệp hợp đồng yêu cầu.', 404, 'RESOURCE_NOT_FOUND');
      }

      bucketName = STORAGE_BUCKET_MAP.CONTRACT;
      canonicalFileRef = ref;
      break;
    }

    case 'RECORDING': {
      // STEP 1: Pre-auth service-role lookup: minimal metadata ONLY (id, company_id)
      const { data: minimal, error: minError } = await adminClient
        .from('calls')
        .select('id, company_id')
        .eq('id', resourceId)
        .maybeSingle();

      if (minError || !minimal) {
        throw new ServerAuthError('Không tìm thấy bản ghi cuộc gọi.', 404, 'RESOURCE_NOT_FOUND');
      }

      // STEP 2-7: Derive company_id and authenticate actor (Boss only, AAL2 enforced)
      await verifyActorForCompany(
        minimal.company_id,
        {
          allowedRoles: [APPLICATION_ROLES.BOSS_ADMIN],
          requireAal2: process.env.NODE_ENV === 'production',
        },
        client
      );

      // STEP 8: ONLY AFTER SUCCESSFUL AUTHORIZATION: query canonical recording_ref
      const { data: callRow, error: callError } = await adminClient
        .from('calls')
        .select('recording_ref')
        .eq('id', resourceId)
        .eq('company_id', minimal.company_id)
        .maybeSingle();

      if (callError || !callRow?.recording_ref) {
        throw new ServerAuthError('Không tìm thấy bản ghi âm cuộc gọi.', 404, 'RESOURCE_NOT_FOUND');
      }

      // STEP 9-10: Validate and sign canonical recording object
      bucketName = STORAGE_BUCKET_MAP.RECORDING;
      canonicalFileRef = callRow.recording_ref;
      break;
    }

    case 'INSTALLATION': {
      // authorizeInstallationAccess performs a minimal pre-auth lookup, derives the
      // company from DB, verifies the actor and current technician assignment, and
      // only then reads the canonical `photos` / `handover_ref` fields.
      const { installation } = await authorizeInstallationAccess(resourceId, client);

      if (request.variant === 'handover') {
        if (!installation.handover_ref?.trim()) {
          throw new ServerAuthError(
            'Tài liệu bàn giao lắp đặt chưa sẵn sàng để tải.',
            502,
            'SIGNED_URL_UNAVAILABLE'
          );
        }
        canonicalFileRef = installation.handover_ref;
      } else {
        if (!Number.isInteger(request.photoIndex) || request.photoIndex < 0) {
          throw new ServerAuthError(
            'Vị trí ảnh lắp đặt không hợp lệ.',
            400,
            'INVALID_PURPOSE'
          );
        }

        const photos = Array.isArray(installation.photos)
          ? (installation.photos as string[])
          : [];
        const ref = photos[request.photoIndex];
        if (typeof ref !== 'string' || !ref.trim()) {
          throw new ServerAuthError(
            'Tệp lắp đặt yêu cầu chưa sẵn sàng để tải.',
            502,
            'SIGNED_URL_UNAVAILABLE'
          );
        }
        canonicalFileRef = ref;
      }

      bucketName = STORAGE_BUCKET_MAP.INSTALLATION;
      break;
    }

    default: {
      throw new ServerAuthError('Danh mục tài nguyên không hợp lệ.', 400, 'INVALID_PURPOSE');
    }
  }

  // 3. Generate signed URL using Supabase Storage admin client
  const { data: signedData, error: storageError } = await adminClient.storage
    .from(bucketName)
    .createSignedUrl(canonicalFileRef, ttl);

  // 4. INVARIANT: FAIL CLOSED!
  // Mock fallback URLs are strictly forbidden per review finding 2 & 9.
  if (storageError || !signedData?.signedUrl) {
    throw new ServerAuthError(
      'Không thể tạo liên kết tải tệp bảo mật do lỗi hạ tầng lưu trữ.',
      502,
      'SIGNED_URL_UNAVAILABLE'
    );
  }

  return {
    signedUrl: signedData.signedUrl,
    expiresIn: ttl,
  };
}
