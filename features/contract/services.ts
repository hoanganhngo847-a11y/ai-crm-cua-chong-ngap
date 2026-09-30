import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/**
 * Tự động sinh hợp đồng dựa trên đơn hàng đã cọc.
 * LUẬT NGHIỆP VỤ BẮT BUỘC: Hợp đồng sinh ra phải bám sát 100% dữ liệu từ đơn hàng và bảng giá.
 * Tuyệt đối không cho phép AI tự động giảm giá, tự tạo cam kết, hay thay đổi điều khoản.
 */
export async function generateContractForOrder(orderId: string) {
  // Use Service Role to act as Trusted Server
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const adminSupabase = createSupabaseClient(supabaseUrl, supabaseServiceKey);

  // Lấy thông tin công ty, khách hàng và trạng thái đơn hàng
  const { data: orderData, error: orderError } = await adminSupabase
    .from('orders')
    .select(`
      company_id, final_amount, deposit_status,
      companies ( name, tax_id, address ),
      customers ( name, phone, address ),
      finance_summaries ( collected_amount )
    `)
    .eq('id', orderId)
    .single();

  if (orderError || !orderData) {
    throw new Error('Không tìm thấy thông tin đơn hàng để tạo hợp đồng');
  }

  if (orderData.deposit_status !== 'DEPOSIT_CONFIRMED') {
    throw new Error('Chỉ được tạo hợp đồng khi đơn hàng đã xác nhận cọc');
  }

  // Find current max revision
  const { data: existingContracts } = await adminSupabase
    .from('contracts')
    .select('revision_no')
    .eq('order_id', orderId)
    .order('revision_no', { ascending: false })
    .limit(1);
    
  const nextRevision = (existingContracts?.[0]?.revision_no || 0) + 1;

  // 2. Sinh Document Generator & Upload lên Storage (Trusted Server) bằng pdf-lib
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage();
  const { width, height } = page.getSize();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  
  // Vẽ dữ liệu thực tế (dynamic) thay cho chuỗi dummy
  page.drawText(`HOP DONG CUNG CAP DICH VU`, { x: 50, y: height - 50, size: 20, font, color: rgb(0, 0, 0) });
  page.drawText(`Ma Don Hang: ${orderId}`, { x: 50, y: height - 80, size: 12, font });
  
  // Customer info
  const customerInfo = orderData.customers ? (Array.isArray(orderData.customers) ? orderData.customers[0] : orderData.customers) : null;
  page.drawText(`Ben A (Khach Hang): ${customerInfo?.name || ''} - Sdt: ${customerInfo?.phone || ''}`, { x: 50, y: height - 110, size: 12, font });
  
  // Company info
  const companyInfo = orderData.companies ? (Array.isArray(orderData.companies) ? orderData.companies[0] : orderData.companies) : null;
  page.drawText(`Ben B (Cong ty): ${companyInfo?.name || ''} - MST: ${companyInfo?.tax_id || ''}`, { x: 50, y: height - 130, size: 12, font });
  
  page.drawText(`Gia Tri HD: ${orderData.final_amount} VND`, { x: 50, y: height - 150, size: 12, font });
  
  const collectedAmount = orderData.finance_summaries ? (Array.isArray(orderData.finance_summaries) ? orderData.finance_summaries[0]?.collected_amount : orderData.finance_summaries?.collected_amount) : 0;
  page.drawText(`Da Dat Coc: ${collectedAmount || 0} VND`, { x: 50, y: height - 170, size: 12, font });

  const pdfBytes = await pdfDoc.save();
  const pdfBuffer = Buffer.from(pdfBytes);
  const filePath = `contracts/${orderData.company_id}/${orderId}/revision-${nextRevision}.pdf`;

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
  const { data: newContract, error } = await adminSupabase
    .from('contracts')
    .upsert({
      company_id: orderData.company_id,
      order_id: orderId,
      status: 'GENERATED',
      revision_no: nextRevision,
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
