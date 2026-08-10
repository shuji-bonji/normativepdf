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
