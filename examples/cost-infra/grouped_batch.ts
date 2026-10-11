import { CostKey } from "costkey";

CostKey.init({
  dsn: process.env.COSTKEY_DSN,
  captureBody: false,
  defaultContext: { environment: "worker", service: "document-worker" },
});

export async function runNightlyImport(itemIds: string[]): Promise<void> {
  try {
    await CostKey.startExecution(
      {
        name: "nightly-document-import",
        kind: "batch",
        expectedItems: itemIds.length,
        configuration: { parser: "v2" },
      },
      async () => {
        for (const itemId of itemIds) {
          await CostKey.withContext(
            { operation: "document.process", itemId },
            () => CostKey.startTrace(
              { name: "document.process" },
              () => existingDocumentWork(itemId),
            ),
          );
        }
      },
    );
  } finally {
    await CostKey.flush();
  }
}

async function existingDocumentWork(itemId: string): Promise<void> {
  // Replace with the existing provider calls. This example makes no request.
  throw new Error(`Replace existingDocumentWork before running (${itemId})`);
}
