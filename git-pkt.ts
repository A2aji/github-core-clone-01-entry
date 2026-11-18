// git-pkt.ts — pkt-line framing and sideband framing for git smart HTTP.
// git's LARGE_PACKET_MAX is 65520 bytes a packet (header included), so a data
// payload is at most 65516 bytes. Pure: no I/O, no clock, no randomness.
//
// Exported API:
//   PKT_LINE_MAX (65520), PKT_LINE_MAX_PAYLOAD (65516),
//   encodePktLine(s: string | Buffer): Buffer
//   encodeFlush(): Buffer               // 0000
//   encodeDelim(): Buffer               // 0001
//   encodeResponseEnd(): Buffer         // 0002
//   encodePktLines(items): Buffer       // strings/Buffers, or 'flush'/'delim'/'response-end'
//   encodeSideband(band: 1|2|3, data: Buffer): Buffer   // pkt-line with band byte prefix
//   encodeAdvertisementLine(oid, refname, caps?): Buffer
//   parsePktLines(buf): { lines: Buffer[], rest: Buffer }
//     // Decodes data packets until the first flush/delim/response-end packet,
//     // a non-hex header, or a truncated packet; `rest` starts at that point
//     // (call again on `rest` after skipping 4 bytes to read the next section).
//   decodePktLines(buf): PktLinePacket[] // every packet incl. control kinds, until raw/truncated
//
// Sideband bands: 1 = pack data / report stream, 2 = progress text, 3 = error.

/** git's LARGE_PACKET_MAX: the largest pkt-line including its 4-byte length. */
export const PKT_LINE_MAX = 65520;
/** The largest pkt-line payload (length minus the 4-byte header). */
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;

function asBuffer(value: string | Uint8Array): Buffer {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/** Encode one data packet: 4 hex length bytes (payload + 4) then the payload. */
export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = asBuffer(payload);
  if (data.length > PKT_LINE_MAX_PAYLOAD) {
    throw new Error(`pkt-line payload is ${data.length} bytes, over the ${PKT_LINE_MAX_PAYLOAD}-byte maximum`);
  }
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

/** The flush packet: `0000`. */
export function encodeFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The delim packet: `0001` (separates a v2 request's command from its arguments). */
export function encodeDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** The response-end packet: `0002`. */
export function encodeResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

export type PktLineItem = string | Uint8Array | 'flush' | 'delim' | 'response-end';

/** Encode a mixed sequence; the strings 'flush'/'delim'/'response-end' are control packets. */
export function encodePktLines(items: ReadonlyArray<PktLineItem>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(encodeFlush());
    else if (item === 'delim') parts.push(encodeDelim());
    else if (item === 'response-end') parts.push(encodeResponseEnd());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

/**
 * One sideband packet: a pkt-line whose payload is a band byte (1, 2 or 3)
 * followed by `data`. The caller chunks `data` so the whole packet stays
 * within PKT_LINE_MAX (at most PKT_LINE_MAX_PAYLOAD - 1 data bytes).
 */
export function encodeSideband(band: 1 | 2 | 3, data: Buffer): Buffer {
  if (data.length > PKT_LINE_MAX_PAYLOAD - 1) {
    throw new Error(`sideband data is ${data.length} bytes, over the ${PKT_LINE_MAX_PAYLOAD - 1}-byte maximum for one packet`);
  }
  return encodePktLine(Buffer.concat([Buffer.from([band]), data]));
}

/** The largest data chunk one sideband packet can carry (band byte + data). */
export const SIDEBAND_MAX_DATA = PKT_LINE_MAX_PAYLOAD - 1;

/** Split `data` into sideband packets of band `band`, each within the size limit. */
export function encodeSidebandStream(band: 1 | 2 | 3, data: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += SIDEBAND_MAX_DATA) {
    packets.push(encodeSideband(band, data.subarray(offset, offset + SIDEBAND_MAX_DATA)));
  }
  return packets;
}

/**
 * One ref-advertisement line: `<oid> <refname>` plus, when `caps` is given,
 * `\0<caps>`, terminated with `\n`, pkt-line framed. Used for the first line
 * of a v0 advertisement (HEAD + capabilities) and for every ref line.
 */
export function encodeAdvertisementLine(oid: string, refname: string, caps?: string): Buffer {
  const text = caps !== undefined ? `${oid} ${refname}\u0000${caps}\n` : `${oid} ${refname}\n`;
  return encodePktLine(text);
}

/**
 * Decode data packets from the start of `buf` until the first flush/delim/
 * response-end packet, a non-hex length header, or a truncated packet.
 * `lines` holds the data payloads in order; `rest` is everything from the
 * stopping point on (starting at the control packet itself, if any). A
 * caller reads section by section: parse, then skip the 4-byte control
 * packet in `rest` and parse again.
 */
export function parsePktLines(buf: Buffer): { lines: Buffer[]; rest: Buffer } {
  const lines: Buffer[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const header = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0 || length === 1 || length === 2 || length === 3) break;
    if (length > PKT_LINE_MAX) break;
    if (offset + length > buf.length) break;
    lines.push(buf.subarray(offset + 4, offset + length));
    offset += length;
  }
  return { lines, rest: buf.subarray(offset) };
}

/** One decoded pkt-line packet, including control packets. */
export type PktLinePacket =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

/**
 * Decode every complete packet in `buf`, in order, stopping at the first
 * non-hex header or truncated packet (the remainder is silently dropped —
 * use parsePktLines when the remainder matters).
 */
export function decodePktLines(buf: Buffer): PktLinePacket[] {
  const packets: PktLinePacket[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const header = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > PKT_LINE_MAX) break;
    if (offset + length > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}
