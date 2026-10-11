export function isValidFxBasis(rateInput: string, sourceInput: string, asOfInput: string): boolean {
  const rate = Number(rateInput);
  return Number.isFinite(rate)
    && rate > 0
    && Boolean(sourceInput.trim())
    && Boolean(asOfInput)
    && !Number.isNaN(new Date(asOfInput).getTime());
}

export interface EditableFindingThresholds {
  expensiveSample: number;
  expensiveMultiplier: number;
  expensiveMinAbsolute: number;
  unitSample: number;
  unitMinRelative: number;
  unitMinImpact: number;
}

export interface FindingThresholdFormValues {
  expensiveSample: string;
  expensiveMultiplier: string;
  expensiveMinAbsolute: string;
  unitSample: string;
  unitMinRelativePercent: string;
  unitMinImpact: string;
}

function boundedNumber(value: string, minimum: number, maximum: number): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function boundedInteger(value: string, minimum: number, maximum: number): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

/** Parse the six UI-editable finding thresholds using the server bounds. */
export function parseFindingThresholdForm(form: FindingThresholdFormValues): EditableFindingThresholds | null {
  const expensiveSample = boundedInteger(form.expensiveSample, 1, 1_000);
  const expensiveMultiplier = boundedNumber(form.expensiveMultiplier, 1, 100);
  const expensiveMinAbsolute = boundedNumber(form.expensiveMinAbsolute, 0, 1_000_000);
  const unitSample = boundedInteger(form.unitSample, 1, 1_000);
  const unitMinRelativePercent = boundedNumber(form.unitMinRelativePercent, 0, 100);
  const unitMinImpact = boundedNumber(form.unitMinImpact, 0, 1_000_000);
  if (expensiveSample == null || expensiveMultiplier == null || expensiveMinAbsolute == null
    || unitSample == null || unitMinRelativePercent == null || unitMinImpact == null) return null;
  return {
    expensiveSample,
    expensiveMultiplier,
    expensiveMinAbsolute,
    unitSample,
    unitMinRelative: unitMinRelativePercent / 100,
    unitMinImpact,
  };
}
