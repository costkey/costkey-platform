import { CostKey } from "costkey";

CostKey.init({
  dsn: process.env.COSTKEY_DSN,
  captureBody: false,
  defaultContext: { environment: "worker", service: "document-worker" },
});

export async function processItem(itemId: string): Promise<void> {
  await CostKey.withContext(
    { operation: "document.process", itemId },
    () =>
      CostKey.startTrace(
        { name: "document.process" },
        () => existingDocumentWork(itemId),
      ),
  );
}

export async function runBatch(itemIds: string[]): Promise<void> {
  try {
    for (const itemId of itemIds) {
      await processItem(itemId);
    }
  } finally {
    // A worker lifecycle boundary is a good place to drain queued telemetry.
    await CostKey.flush();
  }
}

async function existingDocumentWork(itemId: string): Promise<void> {
  // Replace this with the provider calls already made by the worker.
  // This example intentionally does not make a paid request.
  throw new Error(`Replace existingDocumentWork before running (${itemId})`);
}

