/**
 * normativepdf — clause-driven PDF library.
 * Stage 0 surface: COS object model + lexical layer.
 */

export type {
  CosArray,
  CosBoolean,
  CosDict,
  CosInteger,
  CosName,
  CosNull,
  CosObject,
  CosReal,
  CosRef,
  CosStream,
  CosString,
} from './cos/types.js';
export { COS_FALSE, COS_NULL, COS_TRUE, dictGet, dictGetRaw } from './cos/types.js';
export type {
  XrefCompressed,
  XrefEntry,
  XrefFree,
  XrefInUse,
  XrefSection,
  XrefUnknown,
} from './file/file-parser.js';
export { PdfDocument, parsePdf } from './file/file-parser.js';
export type { ParsedObjectStream } from './file/object-stream.js';
export { loadObjectStream, objectFromStream } from './file/object-stream.js';
export { type DecodeOptions, decodeStream } from './filter/decode.js';
export { FilterError } from './filter/error.js';
export { inflate } from './filter/inflate.js';
export {
  applyPredictor,
  DEFAULT_PREDICTOR_PARMS,
  type PredictorParms,
} from './filter/predictor.js';
export {
  EOF,
  hexValue,
  isDelimiter,
  isDigit,
  isHexDigit,
  isNewline,
  isOctalDigit,
  isRegular,
  isWhitespace,
} from './syntax/byte-classes.js';
export { ByteCursor } from './syntax/byte-cursor.js';
export type { Token } from './syntax/lexer.js';
export { isTokenBoundary, LexError, nextToken } from './syntax/lexer.js';
export type { IndirectObject, ParseObjectOptions } from './syntax/object-parser.js';
export { ParseError, parseIndirectObject, parseObject } from './syntax/object-parser.js';
export { TokenReader } from './syntax/token-reader.js';
