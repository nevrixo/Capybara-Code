import { EditDomainError } from "./types.ts";
import type { ByteRange, PositionEncoding, TextPosition, TextRange } from "./types.ts";

interface LogicalLine {
  readonly startUtf16: number;
  readonly endUtf16: number;
  readonly startByte: number;
  readonly endByte: number;
}

const encoder = new TextEncoder();

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

/** JavaScript accepts lone surrogate code units; UTF-8 text editing must not. */
export function assertValidText(text: string, path?: string): void {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new EditDomainError(
          "EDIT_ENCODING_MISMATCH",
          "text contains a lone high surrogate and cannot be edited as UTF-8",
          path === undefined ? {} : { path },
        );
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new EditDomainError(
        "EDIT_ENCODING_MISMATCH",
        "text contains a lone low surrogate and cannot be edited as UTF-8",
        path === undefined ? {} : { path },
      );
    }
  }
}

export function positionToByteOffset(
  text: string,
  position: TextPosition,
  encoding: PositionEncoding,
): number {
  return utf16IndexToByteOffset(text, positionToUtf16Index(text, position, encoding));
}

export function rangeToByteRange(text: string, range: TextRange): ByteRange {
  const start = positionToByteOffset(text, range.start, range.encoding);
  const end = positionToByteOffset(text, range.end, range.encoding);
  if (end < start) {
    throw new EditDomainError("EDIT_RANGE_INVALID", "range end precedes its start");
  }
  return { start, end };
}

export function utf16IndexToByteOffset(text: string, target: number): number {
  assertValidText(text);
  if (!Number.isInteger(target) || target < 0 || target > text.length) {
    throw new EditDomainError("EDIT_RANGE_INVALID", "UTF-16 index is outside the document");
  }
  let index = 0;
  let bytes = 0;
  while (index < target) {
    const point = text.codePointAt(index);
    if (point === undefined) break;
    const width = point > 0xffff ? 2 : 1;
    if (index + width > target) {
      throw new EditDomainError(
        "EDIT_ENCODING_MISMATCH",
        "UTF-16 offset lands inside a surrogate pair",
      );
    }
    bytes += utf8ByteLength(String.fromCodePoint(point));
    index += width;
  }
  return bytes;
}

export function byteOffsetToUtf16Index(text: string, target: number): number {
  assertValidText(text);
  const total = utf8ByteLength(text);
  if (!Number.isInteger(target) || target < 0 || target > total) {
    throw new EditDomainError("EDIT_RANGE_INVALID", "UTF-8 byte offset is outside the document");
  }
  let index = 0;
  let bytes = 0;
  while (index < text.length) {
    if (bytes === target) return index;
    const point = text.codePointAt(index);
    if (point === undefined) break;
    const width = point > 0xffff ? 2 : 1;
    const nextBytes = bytes + utf8ByteLength(String.fromCodePoint(point));
    if (target > bytes && target < nextBytes) {
      throw new EditDomainError(
        "EDIT_ENCODING_MISMATCH",
        "UTF-8 byte offset lands inside a Unicode scalar",
      );
    }
    bytes = nextBytes;
    index += width;
  }
  if (bytes === target) return index;
  throw new EditDomainError("EDIT_RANGE_INVALID", "UTF-8 byte offset is outside the document");
}

export function substringAtByteRange(text: string, range: ByteRange): string {
  if (range.end < range.start) {
    throw new EditDomainError("EDIT_RANGE_INVALID", "range end precedes its start");
  }
  return text.slice(
    byteOffsetToUtf16Index(text, range.start),
    byteOffsetToUtf16Index(text, range.end),
  );
}

export function lineNumberAtByteOffset(text: string, offset: number): number {
  const lines = logicalLineInfos(text);
  if (offset < 0 || offset > utf8ByteLength(text)) {
    throw new EditDomainError("EDIT_RANGE_INVALID", "byte offset is outside the document");
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line !== undefined && offset >= line.startByte) return index + 1;
  }
  return 1;
}

export function logicalLines(text: string): readonly string[] {
  return logicalLineInfos(text).map((line) => text.slice(line.startUtf16, line.endUtf16));
}

function positionToUtf16Index(
  text: string,
  position: TextPosition,
  encoding: PositionEncoding,
): number {
  assertValidText(text);
  if (!Number.isInteger(position.line) || position.line < 1) {
    throw new EditDomainError("EDIT_RANGE_INVALID", "line must be a positive integer");
  }
  if (!Number.isInteger(position.column) || position.column < 1) {
    throw new EditDomainError("EDIT_RANGE_INVALID", "column must be a positive integer");
  }
  const line = logicalLineInfos(text)[position.line - 1];
  if (line === undefined) {
    throw new EditDomainError("EDIT_RANGE_INVALID", "line is outside the document");
  }
  const content = text.slice(line.startUtf16, line.endUtf16);
  return line.startUtf16 + columnToUtf16Index(content, position.column, encoding);
}

function columnToUtf16Index(text: string, column: number, encoding: PositionEncoding): number {
  const targetUnits = column - 1;
  let units = 0;
  let index = 0;
  while (index < text.length) {
    if (units === targetUnits) return index;
    const point = text.codePointAt(index);
    if (point === undefined) break;
    const width = point > 0xffff ? 2 : 1;
    const scalar = String.fromCodePoint(point);
    const nextUnits = units + unitsFor(scalar, width, encoding);
    if (nextUnits > targetUnits) {
      throw new EditDomainError(
        "EDIT_ENCODING_MISMATCH",
        `column lands inside a ${encoding} encoded Unicode scalar`,
      );
    }
    units = nextUnits;
    index += width;
  }
  if (units === targetUnits) return index;
  throw new EditDomainError("EDIT_RANGE_INVALID", "column is outside the logical line");
}

function unitsFor(text: string, utf16Width: number, encoding: PositionEncoding): number {
  switch (encoding) {
    case "utf8":
      return utf8ByteLength(text);
    case "utf16":
      return utf16Width;
    case "unicode_scalar":
      return 1;
  }
}

function logicalLineInfos(text: string): readonly LogicalLine[] {
  assertValidText(text);
  const lines: LogicalLine[] = [];
  let startUtf16 = 0;
  let startByte = 0;
  let index = 0;
  while (index < text.length) {
    const unit = text.charCodeAt(index);
    if (unit !== 0x0a && unit !== 0x0d) {
      index += 1;
      continue;
    }
    const newlineEnd = unit === 0x0d && text.charCodeAt(index + 1) === 0x0a
      ? index + 2
      : index + 1;
    const endByte = startByte + utf8ByteLength(text.slice(startUtf16, index));
    lines.push({ startUtf16, endUtf16: index, startByte, endByte });
    startByte = endByte + utf8ByteLength(text.slice(index, newlineEnd));
    startUtf16 = newlineEnd;
    index = newlineEnd;
  }
  const endByte = startByte + utf8ByteLength(text.slice(startUtf16));
  lines.push({ startUtf16, endUtf16: text.length, startByte, endByte });
  return lines;
}
