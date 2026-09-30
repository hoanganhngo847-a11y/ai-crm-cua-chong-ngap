import { NextResponse } from 'next/server';
import { authorizeOrderAccess } from '@/lib/server-auth/resource-access';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const contractId = params.id;
    const adminSupabase = createAdminClient();

    // Lấy thông tin hợp đồng
    const { data: contract, error: contractError } = await adminSupabase
      .from('contracts')
      .select('order_id, generated_file_ref')
      .eq('id', contractId)
      .single();

    if (contractError || !contract) {
      return NextResponse.json({ error: 'Không tìm thấy hợp đồng' }, { status: 404 });
    }

    if (!contract.generated_file_ref) {
      return NextResponse.json({ error: 'Hợp đồng chưa có file đính kèm' }, { status: 404 });
    }

    // Xác minh quyền truy cập (Dùng chung logic auth qua Order)
    const { actor } = await authorizeOrderAccess(contract.order_id);
    if (actor.role !== 'BOSS_ADMIN') {
      return NextResponse.json({ error: 'Chỉ BOSS_ADMIN mới được phép tải hợp đồng' }, { status: 403 });
    }

    // Tạo Signed URL qua Service Role
    const { data: urlData, error: urlError } = await adminSupabase.storage
      .from('secure-documents')
      .createSignedUrl(contract.generated_file_ref, 60); // Link sống 60s

    if (urlError || !urlData) {
      return NextResponse.json({ error: 'Không thể tạo link tải file' }, { status: 500 });
    }

    return NextResponse.redirect(urlData.signedUrl);
  } catch (error: any) {
    console.error('Lỗi khi tải hợp đồng:', error);
    return NextResponse.json({ error: error.message || 'Lỗi hệ thống' }, { status: 500 });
  }
}
