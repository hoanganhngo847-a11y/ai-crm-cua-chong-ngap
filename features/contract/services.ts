import { createAdminClient } from '@/lib/supabase/admin';
import { verifyActorForCompany, requirePrivilegedBoss } from '@/lib/server-auth/authorize';
import { APPLICATION_ROLES } from '@/shared/constants/roles';
import { STORAGE_BUCKET_MAP, type SignedUrlResult } from '@/shared/contracts/sensitive';
import { createAuthorizedSignedUrl } from '@/lib/sensitive/signed-urls';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface ContractListItemDTO {
  id: string;
  orderId: string;
  orderCode: string;
  customerName: string;
  contractValue: number;
  receivableAmount: number;
  isSigned: boolean;
  status: string;
  revisionNo: number;
  generatedFileRef?: string | null;
  createdAt: string;
}

export const MAX_CONTRACT_PDF_SIZE_BYTES = 10 * 1024 * 1024; // 10MB canonical limit

export function validateSignedPdf(buffer: Buffer): void {
  if (!buffer || buffer.length === 0) {
    throw new Error('INVALID_PDF: Tệp ký rỗng');
  }
  if (buffer.length > MAX_CONTRACT_PDF_SIZE_BYTES) {
    throw new Error('INVALID_PDF: Dung lượng tệp vượt quá giới hạn 10MB');
  }
  // Validate magic header %PDF- (0x25, 0x50, 0x44, 0x46, 0x2D)
  if (buffer.length < 5 || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('INVALID_PDF: Tệp không có định dạng PDF hợp lệ (thiếu header %PDF-)');
  }
}

/**
 * Generates contract for an order after deposit has been confirmed.
 * Uses atomic DB claim to prevent duplicate revisions under concurrent calls.
 * Saves PDF to canonical 'contracts' storage bucket with server-derived path.
 */
export async function generateContractForOrder(
  params: {
    companyId: string;
    orderId: string;
    forceRevision?: boolean;
  },
  client?: SupabaseClient
) {
  const { companyId, orderId, forceRevision = false } = params;
  const adminSupabase = client || createAdminClient();

  // 1. Claim contract generation atomically in DB
  const { data: claimData, error: claimError } = await adminSupabase.rpc(
    'claim_contract_generation_rpc',
    {
      p_company_id: companyId,
      p_order_id: orderId,
      p_force_revision: forceRevision,
    }
  );

  if (claimError || !claimData) {
    throw claimError || new Error('Không thể khởi tạo hợp đồng cho đơn hàng');
  }

  if (claimData.status === 'ALREADY_EXISTS') {
    return {
      contractId: claimData.contractId,
      status: claimData.contractStatus,
      revisionNo: claimData.revisionNo,
      generatedFileRef: claimData.generatedFileRef,
      contractGenerationStatus: 'ALREADY_EXISTS' as const,
    };
  }

  const { contractId, revisionNo, orderFinalAmount } = claimData;

  // 2. Render PDF using pdf-lib (server authoritative facts, no AI guesses)
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage();
  const { height } = page.getSize();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  page.drawText('CONG TY TNHH CUA CHONG NGAP', {
    x: 50,
    y: height - 60,
    size: 16,
    font,
    color: rgb(0, 0, 0),
  });

  page.drawText(`HOP DONG KINH TE - DON HANG: ${orderId}`, {
    x: 50,
    y: height - 90,
    size: 14,
    font,
    color: rgb(0, 0, 0),
  });

  page.drawText(`Gia tri hop dong: ${Number(orderFinalAmount || 0).toLocaleString('vi-VN')} VND`, {
    x: 50,
    y: height - 120,
    size: 12,
    font,
    color: rgb(0, 0, 0),
  });

  page.drawText(`Phien ban: Revision ${revisionNo}`, {
    x: 50,
    y: height - 140,
    size: 10,
    font,
    color: rgb(0.3, 0.3, 0.3),
  });

  const pdfBytes = await pdfDoc.save();
  const pdfBuffer = Buffer.from(pdfBytes);

  // 3. Server-derived canonical storage path in canonical 'contracts' bucket
  const canonicalFilePath = `${companyId}/contracts/${contractId}/revision-${revisionNo}/generated.pdf`;

  const { error: uploadError } = await adminSupabase.storage
    .from(STORAGE_BUCKET_MAP.CONTRACT)
    .upload(canonicalFilePath, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: true,
    });

  if (uploadError) {
    // ResourceAlreadyExists (409) is safe to ignore: canonical path is deterministic per
    // (contractId, revision), so a pre-existing file means a concurrent caller already
    // uploaded the same content. Proceed to finalize.
    const isResourceConflict =
      (uploadError as any)?.statusCode === '409' ||
      (uploadError as any)?.status === 409 ||
      (uploadError as any)?.message?.includes('already exists') ||
      (uploadError as any)?.message?.includes('ResourceAlreadyExists');

    if (!isResourceConflict) {
      console.error('Lỗi khi upload file hợp đồng:', uploadError);
      throw new Error('Không thể lưu trữ tệp hợp đồng');
    }
    // File already exists at canonical path — continue to finalize
  }

  // 4. Finalize contract generation in database
  const { error: finalizeError } = await adminSupabase.rpc(
    'finalize_generated_contract_rpc',
    {
      p_company_id: companyId,
      p_contract_id: contractId,
      p_generated_file_ref: canonicalFilePath,
    }
  );

  if (finalizeError) {
    console.error('Lỗi khi hoàn tất sinh hợp đồng:', finalizeError);
    throw finalizeError;
  }

  return {
    contractId,
    revisionNo,
    status: 'GENERATED',
    generatedFileRef: canonicalFilePath,
    contractGenerationStatus: 'GENERATED' as const,
  };
}

/**
 * Ensures contract generation for an order whose deposit is confirmed (DEPOSIT_CONFIRMED).
 * Recovers from previous contract generation or storage outages safely and idempotently.
 * Never overwrites a SIGNED contract.
 */
export async function ensureContractForDepositConfirmedOrder(
  companyId: string,
  orderId: string,
  client?: SupabaseClient
): Promise<{
  contractId: string;
  revisionNo: number;
  status: string;
  generatedFileRef: string | null;
  contractGenerationStatus: 'GENERATED' | 'ALREADY_EXISTS';
}> {
  const adminSupabase = client || createAdminClient();

  // 1. Verify the Order belongs to the company
  const { data: order, error: orderErr } = await adminSupabase
    .from('orders')
    .select('id, company_id, deposit_status, final_amount, order_code, customer_id')
    .eq('id', orderId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (orderErr || !order) {
    throw new Error('RESOURCE_NOT_FOUND: Order not found');
  }

  // 2. Verify deposit is actually DEPOSIT_CONFIRMED
  if (order.deposit_status !== 'CONFIRMED' && order.deposit_status !== 'DEPOSIT_CONFIRMED') {
    throw new Error('DEPOSIT_NOT_CONFIRMED: Cannot generate or recover contract until deposit is confirmed');
  }

  // 3. Inspect current Contract state
  const { data: currentContract } = await adminSupabase
    .from('contracts')
    .select('id, revision_no, status, generated_file_ref, signed_file_ref, is_current')
    .eq('company_id', companyId)
    .eq('order_id', orderId)
    .eq('is_current', true)
    .maybeSingle();

  if (currentContract) {
    // 6. Never overwrite a SIGNED contract
    if (currentContract.status === 'SIGNED') {
      return {
        contractId: currentContract.id,
        revisionNo: currentContract.revision_no,
        status: currentContract.status,
        generatedFileRef: currentContract.generated_file_ref,
        contractGenerationStatus: 'ALREADY_EXISTS',
      };
    }

    // 5. Reuse an existing claimed/generated contract where appropriate
    if (
      ['GENERATED', 'SENT_TO_CUSTOMER'].includes(currentContract.status) &&
      currentContract.generated_file_ref &&
      currentContract.generated_file_ref !== 'CLAIMED'
    ) {
      return {
        contractId: currentContract.id,
        revisionNo: currentContract.revision_no,
        status: currentContract.status,
        generatedFileRef: currentContract.generated_file_ref,
        contractGenerationStatus: 'ALREADY_EXISTS',
      };
    }
  }

  // 4. Call existing atomic contract-generation claim safely (remains idempotent under concurrent calls)
  const genResult = await generateContractForOrder(
    {
      companyId,
      orderId,
      forceRevision: false,
    },
    adminSupabase
  );

  return {
    contractId: genResult.contractId,
    revisionNo: genResult.revisionNo,
    status: genResult.status,
    generatedFileRef: genResult.generatedFileRef ?? null,
    contractGenerationStatus:
      (genResult.contractGenerationStatus as 'GENERATED' | 'ALREADY_EXISTS') ||
      (genResult.status === 'GENERATED' ? 'GENERATED' : 'ALREADY_EXISTS'),
  };
}

/**
 * Trusted server projection for Contract List.
 * Enforces role allowlist and hides raw finance/memo details from client.
 */
export async function getContractsWithOrderDetails(
  companyId: string,
  client?: SupabaseClient
): Promise<ContractListItemDTO[]> {
  // Authorize actor for company
  await verifyActorForCompany(
    companyId,
    { allowedRoles: [APPLICATION_ROLES.BOSS_ADMIN, APPLICATION_ROLES.SALE] },
    client
  );

  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from('contracts')
    .select(`
      id,
      order_id,
      revision_no,
      status,
      generated_file_ref,
      signed_file_ref,
      contract_value,
      created_at,
      orders (
        id,
        order_code,
        final_amount,
        customers (
          name
        ),
        finance_summaries (
          receivable_amount
        )
      )
    `)
    .eq('company_id', companyId)
    .eq('is_current', true)
    .order('created_at', { ascending: false });

  if (error || !data) {
    console.error('Lỗi khi lấy danh sách hợp đồng:', error);
    return [];
  }

  interface ContractQueryRow {
    id: string;
    order_id: string;
    revision_no: number;
    status: string;
    generated_file_ref: string | null;
    signed_file_ref: string | null;
    contract_value: number | null;
    created_at: string;
    orders?: {
      id?: string;
      order_code?: string | null;
      final_amount?: number | null;
      customers?: {
        name?: string | null;
      } | null;
      finance_summaries?: {
        receivable_amount?: number | null;
      } | null;
    } | null;
  }

  return (data as unknown as ContractQueryRow[]).map((item) => {
    const order = item.orders || {};
    const customer = order.customers || {};
    const finance = order.finance_summaries || {};

    return {
      id: item.id,
      orderId: item.order_id,
      orderCode: order.order_code || item.order_id.slice(0, 8),
      customerName: customer.name || 'Khách hàng',
      contractValue: Number(item.contract_value || order.final_amount || 0),
      receivableAmount: Number(finance.receivable_amount ?? order.final_amount ?? 0),
      isSigned: Boolean(item.signed_file_ref && item.status === 'SIGNED'),
      status: item.status,
      revisionNo: item.revision_no || 1,
      generatedFileRef: item.generated_file_ref,
      createdAt: item.created_at,
    };
  });
}

/**
 * Signs a contract with uploaded signed PDF.
 * STRICT SECURITY ORDER:
 * 1. requirePrivilegedBoss(companyId) -> verifies active profile, active membership, BOSS_ADMIN, MFA AAL2
 * 2. validate PDF bounds (non-empty, <=10MB, %PDF- magic header)
 * 3. trusted DB lookup: contracts.id = contractId AND contracts.company_id = companyId
 * 4. validate current contract and allowed source status
 * 5. read revision_no from canonical contract row
 * 6. derive canonical storage path: <companyId>/contracts/<contractId>/revision-<revisionNo>/signed.pdf
 * 7. upload to storage bucket 'contracts'
 * 8. finalize signing transaction in DB (p_aal_level = actor.aal)
 */
export async function signContract(
  params: {
    companyId: string;
    contractId: string;
    signedPdfBuffer: Buffer;
  },
  client?: SupabaseClient,
  adminClientOverride?: SupabaseClient
) {
  const { companyId, contractId, signedPdfBuffer } = params;

  // 1. Authorize actor: BOSS_ADMIN + strict AAL2 enforcement (no fallback)
  const actor = await requirePrivilegedBoss(companyId, client);
  if (actor.aal !== 'aal2') {
    throw new Error('AAL2_REQUIRED: Ký hợp đồng yêu cầu xác thực MFA AAL2');
  }

  const adminSupabase = adminClientOverride ?? createAdminClient();

  // 2. Trusted DB lookup: verify contract belongs to company before upload
  const { data: contract, error: contractErr } = await adminSupabase
    .from('contracts')
    .select('id, company_id, order_id, revision_no, status, is_current, generated_file_ref, signed_file_ref')
    .eq('id', contractId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (contractErr || !contract) {
    throw new Error('RESOURCE_NOT_FOUND: Contract not found');
  }

  // 3. Validate current contract
  if (!contract.is_current) {
    throw new Error('INVALID_CONTRACT_STATE: Không thể ký hợp đồng không còn hiệu lực');
  }

  // 4. Read actual revision_no from canonical contract row (NO HARDCODED revision-1!)
  const revisionNo = contract.revision_no;

  // 5. Derive canonical storage path using actual revision_no
  const canonicalSignedPath = `${companyId}/contracts/${contractId}/revision-${revisionNo}/signed.pdf`;

  // 6. Section 2: If already SIGNED, return deterministic idempotent result BEFORE any Storage upload or mutation
  if (contract.status === 'SIGNED') {
    if (contract.signed_file_ref && contract.signed_file_ref === canonicalSignedPath) {
      return {
        success: true,
        contractId: contract.id,
        orderId: contract.order_id,
        status: 'ALREADY_PROCESSED',
        alreadyProcessed: true,
      };
    }
    throw new Error('INVALID_CONTRACT_STATE: Hợp đồng đã ở trạng thái SIGNED nhưng đường dẫn lưu trữ không khớp');
  }

  // 7. Validate allowed source status for signing
  if (!['GENERATED', 'SENT_TO_CUSTOMER'].includes(contract.status)) {
    throw new Error(`INVALID_CONTRACT_STATE: Không thể ký hợp đồng ở trạng thái ${contract.status}`);
  }

  if (!contract.generated_file_ref || contract.generated_file_ref === 'CLAIMED') {
    throw new Error('CONTRACT_NOT_READY: Bản nháp hợp đồng chưa sẵn sàng');
  }

  // 8. Validate PDF format and bounds BEFORE upload
  validateSignedPdf(signedPdfBuffer);

  // 9. Section 3: Upload to canonical 'contracts' bucket with upsert: false (create-only, no silent overwrite!)
  const { error: uploadError } = await adminSupabase.storage
    .from(STORAGE_BUCKET_MAP.CONTRACT)
    .upload(canonicalSignedPath, signedPdfBuffer, {
      contentType: 'application/pdf',
      upsert: false,
    });

  if (uploadError) {
    console.error('Lỗi khi upload bản hợp đồng đã ký:', uploadError);
    const errObj = uploadError as unknown as Record<string, unknown>;
    if (
      errObj.statusCode === '409' ||
      errObj.status === 409 ||
      errObj.error === 'Duplicate' ||
      uploadError.message?.toLowerCase().includes('already exists')
    ) {
      throw new Error('STORAGE_OBJECT_ALREADY_EXISTS: Tệp hợp đồng đã ký đã tồn tại trong kho lưu trữ');
    }
    throw new Error('Không thể lưu trữ tệp hợp đồng đã ký');
  }

  // 10. Finalize contract signing atomically in DB with strict actor.aal (no synthesized level)
  interface ContractSigningResult {
    success?: boolean;
    status?: string;
    contractId?: string;
    orderId?: string;
    [key: string]: unknown;
  }

  let rpcData: ContractSigningResult | null = null;
  let rpcError: Error | { message?: string } | null = null;

  try {
    const rpcRes = await adminSupabase.rpc('finalize_contract_signing_rpc', {
      p_company_id: companyId,
      p_contract_id: contractId,
      p_actor_user_id: actor.userId,
      p_signed_file_ref: canonicalSignedPath,
      p_aal_level: actor.aal,
    });
    rpcData = rpcRes.data as unknown as ContractSigningResult;
    rpcError = rpcRes.error;
  } catch (err: unknown) {
    rpcError = err instanceof Error ? err : new Error(String(err));
  }

  if (rpcError || !rpcData?.success) {
    console.error('Lỗi hoặc không chắc chắn khi gọi finalize_contract_signing_rpc:', rpcError);

    // Section 2: Reconcile before cleanup: re-read canonical contract row
    const { data: latestContract, error: rereadErr } = await adminSupabase
      .from('contracts')
      .select('id, company_id, order_id, revision_no, status, is_current, signed_file_ref, signed_at')
      .eq('id', contractId)
      .eq('company_id', companyId)
      .maybeSingle();

    if (rereadErr || !latestContract) {
      console.error('CONTRACT_SIGNING_RECONCILIATION_REQUIRED:', {
        contractId,
        companyId,
        revisionNo,
        operation: 'reconcile_reread',
        error: rereadErr?.message,
      });
      throw new Error('CONTRACT_SIGNING_RECONCILIATION_REQUIRED');
    }

    // Case A — Finalization actually committed (DB committed but RPC/network response was lost)
    if (
      latestContract.status === 'SIGNED' &&
      latestContract.signed_file_ref === canonicalSignedPath
    ) {
      return {
        success: true,
        contractId: latestContract.id,
        orderId: latestContract.order_id,
        status: 'SIGNED',
        alreadyProcessed: true,
      };
    }

    // Case B — DB did NOT finalize: status remains an unsigned allowed state and signed_file_ref is null
    if (
      ['GENERATED', 'SENT_TO_CUSTOMER'].includes(latestContract.status) &&
      !latestContract.signed_file_ref &&
      latestContract.is_current
    ) {
      // Remove ONLY the exact canonical object uploaded by this operation
      let removeError: Error | { message?: string } | null = null;
      try {
        const removeRes = await adminSupabase.storage
          .from(STORAGE_BUCKET_MAP.CONTRACT)
          .remove([canonicalSignedPath]);
        if (removeRes.error) {
          removeError = removeRes.error;
        }
      } catch (err: unknown) {
        removeError = err instanceof Error ? err : new Error(String(err));
      }

      if (removeError) {
        // Section 3: Cleanup failure must not be silent
        console.error('CONTRACT_SIGNING_CLEANUP_FAILED:', {
          contractId,
          companyId,
          revisionNo,
          operation: 'storage_cleanup',
          error: (removeError as { message?: string })?.message,
        });
        throw new Error('CONTRACT_SIGNING_RECONCILIATION_REQUIRED');
      }

      // After successful cleanup, rethrow the original finalization failure so retry can proceed cleanly
      if (rpcError instanceof Error) {
        throw rpcError;
      }
      throw new Error((rpcError as { message?: string })?.message || 'Không thể hoàn tất ký hợp đồng');
    }

    // Case C — DB is in an unexpected / inconsistent state (e.g. SIGNED with another ref, SUPERSEDED, REJECTED, non-current)
    console.error('CONTRACT_SIGNING_INCONSISTENT_STATE:', {
      contractId,
      companyId,
      revisionNo,
      operation: 'reconciliation_state_check',
      status: latestContract.status,
      signedFileRef: latestContract.signed_file_ref,
      isCurrent: latestContract.is_current,
    });
    throw new Error('CONTRACT_SIGNING_RECONCILIATION_REQUIRED');
  }

  return rpcData;
}

/**
 * Creates authorized signed download URL for contract.
 * Reuses existing canonical foundation createAuthorizedSignedUrl helper.
 */
export async function getContractDownloadUrl(
  params: {
    contractId: string;
    variant?: 'generated' | 'signed';
  },
  client?: SupabaseClient
): Promise<SignedUrlResult> {
  const { contractId, variant = 'generated' } = params;

  return createAuthorizedSignedUrl(
    {
      category: 'CONTRACT',
      resourceId: contractId,
      variant,
    },
    client
  );
}
