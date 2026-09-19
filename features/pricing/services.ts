import { createClient } from '@/lib/supabase/server';

export async function getCurrentPricingPolicy(companyId: string) {
  const supabase = createClient();
  const { data, error } = await supabase
    .from('pricing_policies')
    .select('*')
    .eq('company_id', companyId)
    .eq('status', 'ACTIVE')
    .order('effective_at', { ascending: false })
    .limit(1)
    .single();

  if (error) {
    console.error('Lỗi khi lấy chính sách giá hiện hành:', error);
    return null;
  }
  return data;
}

export async function savePriceCalculation(calculation: any) {
  const supabase = createClient();
  const { data, error } = await supabase
    .from('price_calculations')
    .insert([calculation])
    .select()
    .single();

  if (error) {
    console.error('Lỗi khi lưu lịch sử tính giá:', error);
    throw error;
  }
  return data;
}

export async function getPriceCalculations() {
  const supabase = createClient();
  const { data, error } = await supabase
    .from('price_calculations')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Lỗi khi lấy danh sách tính giá:', error);
    return [];
  }
  return data;
}
