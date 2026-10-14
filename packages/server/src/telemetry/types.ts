import type { NormalizedUsage } from "./usage.js";

/** What an extractor knows about one call (the server's view of SDK 0.6's ExtractorCall). */
export interface ExtractCall {
  url: URL;
  method: string;
  /** Request skeleton, with a multipart form as its text fields. */
  requestBody: unknown;
  /** HTTP status; null before a response exists. */
  statusCode: number | null;
  /** Response headers with lowercased names; null before a response exists. */
  responseHeaders: Record<string, string> | null;
}

/** A per-provider extractor reading skeletons, headers and the URL. */
export interface ServerExtractor {
  provider: string;
  match(url: URL): boolean;
  /**
   * Usage from one response body or stream record (null when the body was
   * not read). Providers that bill on the request (characters, queries)
   * read `call` and run even without a body.
   */
  extractUsage(body: unknown, call: ExtractCall): NormalizedUsage | null;
  /** The billed model: from the response, the request, the URL or a default. */
  extractModel(requestBody: unknown, responseBody: unknown, call: ExtractCall): string | null;
  /** Units that are a union over a whole stream rather than per record. */
  extractStreamUnits?(records: unknown[]): Record<string, number> | null;
  /** Extra places a stream record carries usage (beyond itself, `response` and `message`). */
  streamCandidates?(record: Record<string, unknown>): unknown[];
  /**
   * Usage of a request that reached the provider but got no response (the
   * client timed out reading it). Only for providers that bill on the
   * request as soon as they start work, e.g. text-to-speech characters.
   */
  extractUnansweredUsage?(call: ExtractCall): NormalizedUsage | null;
}
