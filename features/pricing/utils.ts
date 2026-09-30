export interface PriceCalculationResult {
  status: 'CALCULATED' | 'NEED_INFO';
  amount: number | null;
  missing_fields: string[];
}

/**
 * Pure price calculation engine deriving strictly from policy price_rules.
 * Invariant: Never guesses missing dimensions or pricing rules.
 */
export function calculatePrice(
  measurements: Record<string, unknown>,
  pricingPolicy: {
    price_rules?: Record<string, unknown>;
    conditions?: Record<string, unknown>;
  } | null | undefined
): PriceCalculationResult {
  const missingFields: string[] = [];

  const width = measurements?.width;
  if (width === undefined || width === null || typeof width !== 'number' || width <= 0) {
    missingFields.push('width');
  }

  const height = measurements?.height;
  if (height === undefined || height === null || typeof height !== 'number' || height <= 0) {
    missingFields.push('height');
  }

  const basePricePerSqm = pricingPolicy?.price_rules?.base_price_per_sqm;
  if (
    basePricePerSqm === undefined ||
    basePricePerSqm === null ||
    typeof basePricePerSqm !== 'number' ||
    basePricePerSqm <= 0
  ) {
    missingFields.push('base_price_per_sqm');
  }

  if (missingFields.length > 0) {
    return {
      status: 'NEED_INFO',
      amount: null,
      missing_fields: missingFields,
    };
  }

  const area = (width as number) * (height as number);
  const totalAmount = Math.round(area * (basePricePerSqm as number) * 100) / 100;

  return {
    status: 'CALCULATED',
    amount: totalAmount,
    missing_fields: [],
  };
}
