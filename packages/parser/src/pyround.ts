/**
 * Python-compatible round(x, ndigits).
 *
 * Python rounds a float to the nearest multiple of 10^-n with ties going to the
 * even digit, decided on the *exact* binary value of the double. JS Math.round
 * is ties-up, so battle durations like 2.25s would diverge from the reference
 * parser (Python: 2.2, naive JS: 2.3) and break golden-fixture parity.
 *
 * Number.prototype.toFixed is spec-guaranteed correctly rounded, so a 20-digit
 * decimal expansion is enough to classify the value against the midpoint: any
 * non-dyadic double differs from an exact .x5 midpoint by ~1e-16, far above
 * 1e-20; only exactly-representable midpoints (2.25, 31.75, ...) expand to a
 * literal trailing "5000…0", and those take the ties-to-even branch.
 */
export function pyRound(x: number, ndigits: number): number {
  if (!Number.isFinite(x)) return x;
  const neg = x < 0;
  const ax = Math.abs(x);
  const EXTRA = 20;
  const s = ax.toFixed(ndigits + EXTRA);
  const dot = s.indexOf(".");
  const intPart = s.slice(0, dot);
  const decimals = s.slice(dot + 1);
  const keep = decimals.slice(0, ndigits);
  const rest = decimals.slice(ndigits); // EXTRA digits deciding the rounding

  const midpoint = "5" + "0".repeat(EXTRA - 1);
  let roundUp: boolean;
  if (rest > midpoint) {
    roundUp = true;
  } else if (rest < midpoint) {
    roundUp = false;
  } else {
    // exact tie: round so the last kept digit (or the integer part when
    // ndigits === 0) becomes even
    const lastKept = ndigits > 0 ? keep[ndigits - 1]! : intPart[intPart.length - 1]!;
    roundUp = parseInt(lastKept, 10) % 2 === 1;
  }

  let result: number;
  if (!roundUp) {
    result = Number(intPart + (ndigits > 0 ? "." + keep : ""));
  } else {
    // add one ulp at the kept precision via integer arithmetic on the digits
    const digits = intPart + keep;
    const bumped = (BigInt(digits) + 1n).toString().padStart(digits.length, "0");
    const cut = bumped.length - ndigits;
    result = Number(bumped.slice(0, cut) + (ndigits > 0 ? "." + bumped.slice(cut) : ""));
  }
  return neg ? -result : result;
}
