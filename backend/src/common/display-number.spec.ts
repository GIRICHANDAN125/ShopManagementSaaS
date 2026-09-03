import { deriveDisplayNumber, formatDisplayNumber } from './display-number';

describe('deriveDisplayNumber', () => {
  // NOTE: PROJECT_BLUEPRINT.md's illustrative example for large numbers
  // states "1000999 -> 999, 1001000 -> 001, 1001001 -> 002". That is
  // arithmetically inconsistent with the explicitly approved formula
  // ((order_number-1) % 999)+1 — 1000998 is exactly divisible by 999, so
  // 1000999 correctly maps to 1, not 999. This test asserts the actual
  // approved FORMULA's output (verified independently below), not the
  // blueprint's unverified illustrative numbers. Flagged for documentation
  // correction — see final report.
  const cases: [number, number][] = [
    [1, 1],
    [2, 2],
    [998, 998],
    [999, 999],
    [1000, 1],
    [1001, 2],
    [1998, 999],
    [1999, 1],
    [1000999, 1],
    [1001000, 2],
    [1001001, 3],
  ];

  it.each(cases)('order_number %i -> display %i', (orderNumber, expected) => {
    expect(deriveDisplayNumber(orderNumber)).toBe(expected);
  });

  it('never returns 0 for any input in a wide range', () => {
    for (let n = 1; n <= 10000; n++) {
      expect(deriveDisplayNumber(n)).not.toBe(0);
      expect(deriveDisplayNumber(n)).toBeGreaterThanOrEqual(1);
      expect(deriveDisplayNumber(n)).toBeLessThanOrEqual(999);
    }
  });

  it('works with bigint input identically to number input', () => {
    expect(deriveDisplayNumber(1000000n)).toBe(deriveDisplayNumber(1000000));
  });
});

describe('formatDisplayNumber', () => {
  it('zero-pads to 3 digits', () => {
    expect(formatDisplayNumber(1)).toBe('001');
    expect(formatDisplayNumber(42)).toBe('042');
    expect(formatDisplayNumber(999)).toBe('999');
  });
});
