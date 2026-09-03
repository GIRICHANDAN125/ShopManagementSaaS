/**
 * Deterministic customer display number derivation (ARCHITECTURE.md §7,
 * DATABASE.md §5.4). Pure function, stateless, re-derivable from
 * order_number alone — never stored as an independent counter.
 * Never returns 0; wraps 999 -> 1.
 */
export function deriveDisplayNumber(orderNumber: bigint | number): number {
  const n = typeof orderNumber === 'bigint' ? orderNumber : BigInt(orderNumber);
  const mod = Number(((n - 1n) % 999n + 999n) % 999n); // safe for n=0 edge case too
  return mod + 1;
}

export function formatDisplayNumber(displayNumber: number): string {
  return displayNumber.toString().padStart(3, '0');
}
