import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/**
 * Tự động sinh hợp đồng dựa trên đơn hàng đã cọc.
 * LUẬT NGHIỆP VỤ BẮT BUỘC: Hợp đồng sinh ra phải bám sát 100% dữ liệu từ đơn hàng và bảng giá.
 * Tuyệt đối không cho phép AI tự động giảm giá, tự tạo cam kết, hay thay đổi điều khoản.
 */
export async function generateContractForOrder(orderId: string, customerId: string) {
  // Use Service Role to act as Trusted Server
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const adminSupabase = createSupabaseClient(supabaseUrl, supabaseServiceKey);

  // Lấy thông tin công ty và trạng thái đơn hàng
  const { data: orderData } = await adminSupabase
    .from('orders')
    .select('company_id, final_amount, deposit_status')
    .eq('id', orderId)
    .single();

  if (!orderData) {
    throw new Error('Không tìm thấy thông tin đơn hàng để tạo hợp đồng');
  }

  if (orderData.deposit_status !== 'DEPOSIT_CONFIRMED') {
    throw new Error('Chỉ được tạo hợp đồng khi đơn hàng đã xác nhận cọc');
  }

  // 2. Sinh Document Generator & Upload lên Storage (Trusted Server) bằng pdf-lib
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage();
  const { width, height } = page.getSize();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  page.drawText(`Hop dong cho Don hang ${orderId}`, {
    x: 50,
    y: height - 100,
    size: 20,
    font,
    color: rgb(0, 0, 0),
  });
  const pdfBytes = await pdfDoc.save();
  const pdfBuffer = Buffer.from(pdfBytes);
  const filePath = `contracts/${orderId}/contract_v1_${Date.now()}.pdf`;

  const { error: uploadError } = await adminSupabase.storage
    .from('secure-documents')
    .upload(filePath, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: true
    });

  if (uploadError) {
    console.error('Lỗi khi upload file hợp đồng:', uploadError);
    // Vẫn tiếp tục hoặc throw? Hợp đồng BẮT BUỘC lưu storage thành công
    throw new Error('Không thể tạo file hợp đồng');
  }

  // 3. Tạo bản ghi Hợp đồng (Contract) liên kết chặt chẽ với Order
  // Sử dụng upsert (có thể dựa trên unique constraint của order_id) để tránh race condition
  const { data: newContract, error } = await adminSupabase
    .from('contracts')
    .upsert({
      company_id: orderData.company_id,
      order_id: orderId,
      status: 'GENERATED',
      revision_no: 1,
      template_version: 'v1',
      generated_file_ref: filePath, // Dùng đường dẫn thực tế từ upload thành công
      contract_value: orderData.final_amount,
      signed_file_ref: null
    }, { onConflict: 'order_id, revision_no', ignoreDuplicates: true })
    .select()
    .single();

  if (error) {
    console.error('Lỗi khi hệ thống tự động sinh hợp đồng:', error);
    throw error;
  }

  return newContract;
}

export async function getContractsWithOrderDetails() {
  const supabase = await createClient();
  
  // Lấy danh sách hợp đồng kèm theo thông tin công nợ từ bảng finance_summaries
  const { data, error } = await supabase
    .from('contracts')
    .select(`
      id,
      status,
      signed_file_ref,
      created_at,
      orders (
        id,
        final_amount,
        customers (
          id,
          name
        ),
        finance_summaries (
          receivable_amount
        )
      )
    `)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Lỗi khi lấy danh sách hợp đồng và công nợ:', error);
    return [];
  }
  return data;
}
