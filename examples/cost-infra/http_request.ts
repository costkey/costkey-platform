import { CostKey } from "costkey";

// Keep the DSN in the process environment. Do not put it in source control.
CostKey.init({
  dsn: process.env.COSTKEY_DSN,
  captureBody: false,
  defaultContext: {
    environment: "production",
    service: "search-api",
  },
});

export async function handleSearch(query: string, customerId: string) {
  return CostKey.withContext(
    { feature: "search", customer: customerId },
    () =>
      CostKey.startTrace(
        { name: "POST /search" },
        () => existingSearch(query),
      ),
  );
}

async function existingSearch(query: string): Promise<{ answer: string }> {
  // Replace this function with your existing provider client call.
  // This example intentionally does not make a paid request.
  throw new Error(`Replace existingSearch before running (${query.length} chars)`);
}

