import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type ClickToCallParams,
  type ClickToCallResult,
  type SanitizedInteractionDTO,
  type SignedUrlRequest,
  type SignedUrlResult,
  type CallTranscriptDTO,
  CONTACT_ACCESS_PURPOSES,
} from '../../shared/contracts/sensitive';
import { isServerAuthError } from '../server-auth/errors';
import { executeClickToCall } from './click-to-call';
import { getSanitizedInteractionForSale } from './interactions';
import { createAuthorizedSignedUrl } from './signed-urls';
import { resolveCustomerPrivateContactForTrustedOperation } from './customer-contact';
import { getVerbatimCallTranscript } from './call-transcripts';

// ==============================================================================
// INTERNAL SERVER-ONLY ACTION HANDLERS
// (Supports dependency injection for testing — NEVER exported from 'use server' file)
// ==============================================================================

export async function internalClickToCallAction(
  params: ClickToCallParams,
  client?: SupabaseClient
): Promise<{ success: boolean; data?: ClickToCallResult; error?: string; message?: string }> {
  try {
    const result = await executeClickToCall(params, undefined, client);
    return {
      success: true,
      data: result,
    };
  } catch (err: unknown) {
    if (isServerAuthError(err)) {
      return {
        success: false,
        error: err.code,
        message: err.message,
      };
    }
    return {
      success: false,
      error: 'INTERNAL_ERROR',
      message: 'Không thể thực hiện cuộc gọi vào lúc này.',
    };
  }
}

export async function internalGetSanitizedInteractionAction(
  params: { interactionId: string },
  client?: SupabaseClient
): Promise<{ success: boolean; data?: SanitizedInteractionDTO; error?: string; message?: string }> {
  try {
    const result = await getSanitizedInteractionForSale(params.interactionId, client);
    return {
      success: true,
      data: result,
    };
  } catch (err: unknown) {
    if (isServerAuthError(err)) {
      return {
        success: false,
        error: err.code,
        message: err.message,
      };
    }
    return {
      success: false,
      error: 'INTERNAL_ERROR',
      message: 'Không thể tải nội dung tương tác.',
    };
  }
}

export async function internalGetAuthorizedSignedUrlAction(
  params: SignedUrlRequest,
  client?: SupabaseClient
): Promise<{ success: boolean; data?: SignedUrlResult; error?: string; message?: string }> {
  try {
    const result = await createAuthorizedSignedUrl(params, client);
    return {
      success: true,
      data: result,
    };
  } catch (err: unknown) {
    if (isServerAuthError(err)) {
      return {
        success: false,
        error: err.code,
        message: err.message,
      };
    }
    return {
      success: false,
      error: 'INTERNAL_ERROR',
      message: 'Không thể tạo liên kết tải tệp bảo mật.',
    };
  }
}

export async function internalViewBossRawPhoneAction(
  params: { customerId: string; reason: string },
  client?: SupabaseClient
): Promise<{ success: boolean; rawPhone?: string; error?: string; message?: string }> {
  try {
    const contact = await resolveCustomerPrivateContactForTrustedOperation(
      params.customerId,
      CONTACT_ACCESS_PURPOSES.PRIVILEGED_ADMIN_OPERATION,
      { reason: params.reason, client }
    );

    return {
      success: true,
      rawPhone: contact.rawPhone,
    };
  } catch (err: unknown) {
    if (isServerAuthError(err)) {
      return {
        success: false,
        error: err.code,
        message: err.message,
      };
    }
    return {
      success: false,
      error: 'INTERNAL_ERROR',
      message: 'Không có quyền truy cập số điện thoại bảo mật.',
    };
  }
}

export async function internalRevealCustomerPhoneAction(
  params: { customerId: string },
  client?: SupabaseClient
): Promise<{ success: boolean; phone?: string; error?: string; message?: string }> {
  try {
    const isDemo =
      process.env.DEMO_MODE === 'true' || process.env.NEXT_PUBLIC_DEMO_MODE === 'true';

    if (isDemo && params.customerId.startsWith('cust-')) {
      const mockMap: Record<string, string> = {
        'cust-1': '0912345612',
        'cust-2': '0934567890',
        'cust-3': '0987654321',
        'cust-4': '0977889900',
      };
      if (mockMap[params.customerId]) {
        return { success: true, phone: mockMap[params.customerId] };
      }
    }

    try {
      const contact = await resolveCustomerPrivateContactForTrustedOperation(
        params.customerId,
        CONTACT_ACCESS_PURPOSES.CLICK_TO_CALL,
        client
      );

      const phone = contact.rawPhone || contact.normalizedPhone;
      if (!phone) {
        return {
          success: false,
          error: 'NO_PHONE',
          message: 'Khách hàng chưa có số điện thoại.',
        };
      }

      return {
        success: true,
        phone,
      };
    } catch (contactErr: unknown) {
      if (isDemo) {
        return {
          success: true,
          phone: '0912345678',
        };
      }
      throw contactErr;
    }
  } catch (err: unknown) {
    if (isServerAuthError(err)) {
      return {
        success: false,
        error: err.code,
        message: err.message,
      };
    }
    return {
      success: false,
      error: 'INTERNAL_ERROR',
      message: 'Không có quyền truy cập số điện thoại bảo mật.',
    };
  }
}

export async function internalGetCallTranscriptAction(
  params: { callId: string },
  client?: SupabaseClient
): Promise<{ success: boolean; data?: CallTranscriptDTO; error?: string; message?: string }> {
  try {
    const result = await getVerbatimCallTranscript(params.callId, { client });
    return {
      success: true,
      data: result,
    };
  } catch (err: unknown) {
    if (isServerAuthError(err)) {
      return {
        success: false,
        error: err.code,
        message: err.message,
      };
    }
    return {
      success: false,
      error: 'INTERNAL_ERROR',
      message: 'Không thể tải nội dung bóc băng cuộc gọi.',
    };
  }
}
