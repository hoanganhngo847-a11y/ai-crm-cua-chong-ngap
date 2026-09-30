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
export async function generateContractForOrder(params: {
  companyId: string;
  orderId: string;
  forceRevision?: boolean;
}) {
  const { companyId, orderId, forceRevision = false } = params;
  const adminSupabase = createAdminClient();

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
    console.error('Lỗi khi upload file hợp đồng:', uploadError);
    throw new Error('Không thể lưu trữ tệp hợp đồng');
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
      status,
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
    status: string;
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
  client?: SupabaseClient
) {
  const { companyId, contractId, signedPdfBuffer } = params;

  // 1. Authorize actor: BOSS_ADMIN + strict AAL2 enforcement (no fallback)
  const actor = await requirePrivilegedBoss(companyId, client);
  if (actor.aal !== 'aal2') {
    throw new Error('AAL2_REQUIRED: Ký hợp đồng yêu cầu xác thực MFA AAL2');
  }

  const adminSupabase = createAdminClient();

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

  // 4. Validate allowed status
  if (contract.status === 'SIGNED') {
    // If already signed, will be handled deterministically by atomic RPC
  } else if (!['GENERATED', 'SENT_TO_CUSTOMER'].includes(contract.status)) {
    throw new Error(`INVALID_CONTRACT_STATE: Không thể ký hợp đồng ở trạng thái ${contract.status}`);
  }

  if (!contract.generated_file_ref || contract.generated_file_ref === 'CLAIMED') {
    throw new Error('CONTRACT_NOT_READY: Bản nháp hợp đồng chưa sẵn sàng');
  }

  // 5. Read actual revision_no from canonical contract row (NO HARDCODED revision-1!)
  const revisionNo = contract.revision_no;

  // 6. Derive canonical storage path using actual revision_no
  const canonicalSignedPath = `${companyId}/contracts/${contractId}/revision-${revisionNo}/signed.pdf`;

  // 7. Validate PDF format and bounds BEFORE upload
  validateSignedPdf(signedPdfBuffer);

  // 8. Upload to canonical 'contracts' bucket
  const { error: uploadError } = await adminSupabase.storage
    .from(STORAGE_BUCKET_MAP.CONTRACT)
    .upload(canonicalSignedPath, signedPdfBuffer, {
      contentType: 'application/pdf',
      upsert: true,
    });

  if (uploadError) {
    console.error('Lỗi khi upload bản hợp đồng đã ký:', uploadError);
    throw new Error('Không thể lưu trữ tệp hợp đồng đã ký');
  }

  // 9. Finalize contract signing atomically in DB with strict actor.aal (no synthesized level)
  const { data, error } = await adminSupabase.rpc('finalize_contract_signing_rpc', {
    p_company_id: companyId,
    p_contract_id: contractId,
    p_actor_user_id: actor.userId,
    p_signed_file_ref: canonicalSignedPath,
    p_aal_level: actor.aal,
  });

  if (error || !data?.success) {
    console.error('Lỗi khi cập nhật trạng thái hợp đồng đã ký:', error);
    throw error || new Error('Không thể hoàn tất ký hợp đồng');
  }

  return data;
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
