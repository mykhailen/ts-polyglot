// The slice of the content mapper protocol this mapper uses. Notes on the rest: docs/content-mappers.md.
// Full protocol: https://github.com/microsoft/typescript-go/pull/4712, amended by
// https://github.com/microsoft/TypeScript/pull/63936.

export type PositionEncoding = "utf-8" | "utf-16";

export interface InitializeParams {
  positionEncodings: PositionEncoding[];
}

export interface InitializeResult {
  positionEncoding: PositionEncoding;
  diagnosticSource: string;
}

export interface TransformParams {
  fileName: string;
  content: string;
  projectHandle: string;
}

export interface TransformResult {
  text: string;
  extension: ".ts";
  mappings?: SpanMapping[];
}

/** Positions and lengths are in the chosen position encoding. */
export type SpanMapping = [
  virtualStart: number,
  virtualLength: number,
  originalStart: number,
  originalLength: number,
  kind: SpanMapKind,
  features?: number,
];

export const SpanMapKind = {
  Verbatim: 0,
  Atom: 1,
  Alias: 2,
} as const;

export type SpanMapKind = (typeof SpanMapKind)[keyof typeof SpanMapKind];
