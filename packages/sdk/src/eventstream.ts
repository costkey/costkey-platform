/**
 * AWS binary event-stream decoding (application/vnd.amazon.eventstream), the
 * framing Bedrock uses for converse-stream and invoke-with-response-stream:
 *
 *   [total_len u32][headers_len u32][prelude_crc u32][headers][payload][message_crc u32]
 *
 * The SDK reads a tee'd copy only to find usage, so CRCs are not verified;
 * lengths are bounds-checked and a malformed frame stops decoding without
 * touching the caller's stream.
 */

export type EventStreamHeaderValue = string | number | boolean | Uint8Array;

export interface EventStreamMessage {
  headers: Record<string, EventStreamHeaderValue>;
  payload: Uint8Array;
}

const PRELUDE_BYTES = 12;
const MIN_MESSAGE_BYTES = 16;
// AWS caps a single event-stream message at 16 MB.
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const utf8 = new TextDecoder();

/** Incremental decoder: push chunks as they arrive, get back complete messages. */
export class EventStreamDecoder {
  private buffer: Uint8Array = new Uint8Array(0);
  private failed = false;

  push(chunk: Uint8Array): EventStreamMessage[] {
    if (this.failed || chunk.byteLength === 0) return [];
    this.buffer = concat(this.buffer, chunk);
    const messages: EventStreamMessage[] = [];
    let offset = 0;
    while (this.buffer.byteLength - offset >= PRELUDE_BYTES) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + offset);
      const totalLength = view.getUint32(0);
      const headersLength = view.getUint32(4);
      if (
        totalLength < MIN_MESSAGE_BYTES ||
        totalLength > MAX_MESSAGE_BYTES ||
        headersLength > totalLength - MIN_MESSAGE_BYTES
      ) {
        return this.fail(messages);
      }
      if (this.buffer.byteLength - offset < totalLength) break;
      const headersStart = offset + PRELUDE_BYTES;
      const headers = decodeHeaders(this.buffer.subarray(headersStart, headersStart + headersLength));
      if (!headers) return this.fail(messages);
      messages.push({
        headers,
        payload: this.buffer.slice(headersStart + headersLength, offset + totalLength - 4),
      });
      offset += totalLength;
    }
    if (offset > 0) this.buffer = this.buffer.slice(offset);
    return messages;
  }

  private fail(messages: EventStreamMessage[]): EventStreamMessage[] {
    this.failed = true;
    this.buffer = new Uint8Array(0);
    return messages;
  }
}

/** Decode every message in a complete event-stream body. */
export function decodeEventStream(bytes: Uint8Array): EventStreamMessage[] {
  return new EventStreamDecoder().push(bytes);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b;
  const joined = new Uint8Array(a.byteLength + b.byteLength);
  joined.set(a, 0);
  joined.set(b, a.byteLength);
  return joined;
}

/**
 * Header: name_len u8, name, value_type u8, value. Value types: 0/1 bool
 * true/false, 2 byte, 3 short, 4 int, 5 long, 6 byte array (u16 length),
 * 7 string (u16 length), 8 timestamp (i64 ms), 9 uuid (16 bytes).
 */
function decodeHeaders(bytes: Uint8Array): Record<string, EventStreamHeaderValue> | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headers: Record<string, EventStreamHeaderValue> = {};
  let pos = 0;
  const need = (count: number): boolean => pos + count <= bytes.byteLength;
  while (pos < bytes.byteLength) {
    const nameLength = view.getUint8(pos);
    pos += 1;
    if (!need(nameLength + 1)) return null;
    const name = utf8.decode(bytes.subarray(pos, pos + nameLength));
    pos += nameLength;
    const type = view.getUint8(pos);
    pos += 1;
    let value: EventStreamHeaderValue;
    switch (type) {
      case 0: value = true; break;
      case 1: value = false; break;
      case 2:
        if (!need(1)) return null;
        value = view.getInt8(pos); pos += 1; break;
      case 3:
        if (!need(2)) return null;
        value = view.getInt16(pos); pos += 2; break;
      case 4:
        if (!need(4)) return null;
        value = view.getInt32(pos); pos += 4; break;
      case 5:
      case 8:
        if (!need(8)) return null;
        value = Number(view.getBigInt64(pos)); pos += 8; break;
      case 6:
      case 7: {
        if (!need(2)) return null;
        const length = view.getUint16(pos);
        pos += 2;
        if (!need(length)) return null;
        const raw = bytes.slice(pos, pos + length);
        value = type === 7 ? utf8.decode(raw) : raw;
        pos += length;
        break;
      }
      case 9:
        if (!need(16)) return null;
        value = Array.from(bytes.subarray(pos, pos + 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
        pos += 16;
        break;
      default:
        return null;
    }
    headers[name] = value;
  }
  return headers;
}

/**
 * The usage-bearing JSON of one Bedrock stream event, or null. converse-stream
 * reports usage on its `metadata` event; invoke-with-response-stream wraps the
 * model's own JSON chunk as base64 in `{"bytes": ...}`, where Anthropic models
 * put usage on message_start/message_delta and Bedrock adds
 * `amazon-bedrock-invocationMetrics` to the last chunk.
 */
export function bedrockStreamRecord(message: EventStreamMessage): unknown {
  const messageType = message.headers[":message-type"];
  if (messageType !== undefined && messageType !== "event") return null;
  const eventType = message.headers[":event-type"];
  if (eventType !== "metadata" && eventType !== "chunk") return null;
  const payload = JSON.parse(utf8.decode(message.payload)) as unknown;
  if (eventType === "metadata") return payload;
  const bytes = payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)["bytes"]
    : undefined;
  if (typeof bytes !== "string") return null;
  return JSON.parse(Buffer.from(bytes, "base64").toString("utf8")) as unknown;
}
