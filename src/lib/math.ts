const USD_DECIMALS = 6;

/**
 * Parse a decimal string like "100.50" into BigInt base units (100500000).
 */
export function parseDecimal(value: string, decimals = USD_DECIMALS): bigint {
  const [whole = "0", frac = ""] = value.split(".");
  const padded = frac.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole + padded);
}

/**
 * Format a BigInt in base units back to a decimal string like "100.50".
 */
export function formatDecimal(value: bigint, decimals = USD_DECIMALS): string {
  const s = value.toString().padStart(decimals + 1, "0");
  const intPart = s.slice(0, -decimals);
  const fracPart = s.slice(-decimals);
  return `${intPart}.${fracPart}`;
}

/**
 * Compute (numerator / denominator) × 100 as a decimal string.
 * Both inputs are decimal strings with the given scale.
 */
export function pctChange(
  numerator: string,
  denominator: string,
  decimals = USD_DECIMALS,
): string {
  const num = parseDecimal(numerator, decimals);
  const den = parseDecimal(denominator, decimals);
  if (den === 0n) return "0";
  const scaled = (num * 100n * 10n ** BigInt(decimals)) / den;
  return formatDecimal(scaled, decimals);
}
