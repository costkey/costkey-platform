import { CostKey } from "costkey";

CostKey.init({ dsn: process.env.COSTKEY_DSN, captureBody: false });

type EvalCase = { id: string; input: string };

export async function runEvaluation(
  cases: EvalCase[],
  variant: string,
  datasetRevision: string,
): Promise<void> {
  await CostKey.withContext(
    { datasetRevision },
    () => CostKey.startExecution(
      {
        name: "search-eval",
        kind: "evaluation",
        expectedItems: cases.length,
        configuration: { variant },
      },
      async () => {
        for (const testCase of cases) {
          await CostKey.withContext(
            { caseId: testCase.id, phase: "generation" },
            () => CostKey.startTrace(
              { name: "eval.generation" },
              () => existingGeneration(testCase.input),
            ),
          );

          await CostKey.withContext(
            { caseId: testCase.id, phase: "scoring" },
            () => CostKey.startTrace(
              { name: "eval.scoring" },
              () => existingJudge(testCase),
            ),
          );
        }
      },
    ),
  );
  await CostKey.flush();
}

async function existingGeneration(input: string): Promise<unknown> {
  // Replace with the generation provider call. This example makes no request.
  throw new Error(`Replace existingGeneration before running (${input.length} chars)`);
}

async function existingJudge(testCase: EvalCase): Promise<unknown> {
  // Replace with the external judge call, if the harness has one.
  throw new Error(`Replace existingJudge before running (${testCase.id})`);
}

// For a non-HTTP component, recordUsage is the source-contract escape hatch:
// await CostKey.recordUsage({
//   id: `judge:${testCase.id}:r1`, componentId: "external-judge",
//   chargeId: `judge:${testCase.id}`, revision: 1, aggregation: "delta",
//   provider: "external-judge", usage: { requests: 1 },
// });
