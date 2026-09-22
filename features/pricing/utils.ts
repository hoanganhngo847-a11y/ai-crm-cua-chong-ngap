export function calculatePrice(measurements: { width?: number; height?: number; [key: string]: any }, pricingPolicy: any) {
  const missingFields: string[] = [];
  
  if (measurements.width === undefined || measurements.width === null) {
    missingFields.push('width');
  }
  if (measurements.height === undefined || measurements.height === null) {
    missingFields.push('height');
  }

  // Nếu thiếu thông số quan trọng, tuyệt đối không tự đoán giá hay tính bừa.
  if (missingFields.length > 0) {
    return {
      status: 'NEED_INFO',
      amount: null,
      missing_fields: missingFields
    };
  }

  const basePricePerSqm = pricingPolicy?.price_rules?.base_price_per_sqm;
  
  if (basePricePerSqm === undefined || basePricePerSqm === null) {
    missingFields.push('base_price_per_sqm');
    return {
      status: 'NEED_INFO',
      amount: null,
      missing_fields: missingFields
    };
  }
  
  const widthInMeters = measurements.width;
  const heightInMeters = measurements.height;
  const area = widthInMeters * heightInMeters;
  const totalAmount = area * basePricePerSqm;

  return {
    status: 'CALCULATED',
    amount: totalAmount,
    missing_fields: []
  };
}
