/**
 * Safe expression engine — public surface. A non-Turing-complete infix
 * mini-language (tokenizer → Pratt parser → whitelisted-AST interpreter) with
 * NO eval / new Function / node:vm, NO member access, NO loops/lambdas, and
 * hard resource bounds. It is the derivation language of a composed device and
 * the escape-hatch leaf of an automation's condition tree.
 *
 * This is the module barrel; leaf files inside @camstack/types MUST import from
 * the deep modules (e.g. `../expression/compile.js`), never through this file
 * OR the root barrel (see biome-plugins/no-types-barrel-leaf-import.grit).
 */
export type {
  ExpressionBinaryNode,
  ExpressionBinaryOperator,
  ExpressionCallNode,
  ExpressionConditionalNode,
  ExpressionIdentifierNode,
  ExpressionLiteralNode,
  ExpressionLogicalNode,
  ExpressionLogicalOperator,
  ExpressionNode,
  ExpressionNodePath,
  ExpressionUnaryNode,
  ExpressionUnaryOperator,
  ExpressionValue,
} from './ast.js'
export type {
  ExpressionBindingSource,
  ExpressionFieldBinding,
  ExpressionGlobalBinding,
  ExpressionLiteralBinding,
  ExpressionSource,
} from './binding-source.js'
export {
  ExpressionBindingSourceSchema,
  ExpressionFieldBindingSchema,
  ExpressionGlobalBindingSchema,
  ExpressionLiteralBindingSchema,
  ExpressionSourceSchema,
} from './binding-source.js'
export type {
  ExpressionBuiltin,
  ExpressionEvalHooks,
  StatefulExpressionBuiltin,
} from './builtins.js'
export {
  disarmRoseMemory,
  evaluateCount,
  evaluateRose,
  EXPRESSION_BUILTIN_NAMES,
  EXPRESSION_BUILTINS,
  isStatefulBuiltin,
} from './builtins.js'
export type { CompileResult } from './compile.js'
export { compileExpression, compileExpressionSafe } from './compile.js'
export { ExpressionEvalError, ExpressionParseError } from './errors.js'
export type { ExpressionEvalOptions, StatefulCallInvocation } from './evaluator.js'
export { createExpressionScope, evaluateAst } from './evaluator.js'
export type {
  CountCallState,
  EvaluateExpressionSourceResult,
  ExpressionSourceInput,
  RoseCallState,
  StatefulCallState,
  StatefulExpressionEnvironment,
  StatefulExpressionMemory,
} from './expression-source.js'
export {
  cloneStatefulExpressionMemory,
  createStatefulExpressionMemory,
  EXPRESSION_INJECTED_NOW,
  evaluateExpressionSource,
  evaluateStatefulExpressionCall,
  toExpressionValue,
  validateExpressionSource,
} from './expression-source.js'
export {
  EXPRESSION_COMPILE_CACHE_CAPACITY,
  EXPRESSION_IDENTIFIER_RE,
  MAX_EXPRESSION_AST_NODES,
  MAX_EXPRESSION_BINDINGS,
  MAX_EXPRESSION_CALL_ARGS,
  MAX_EXPRESSION_EVAL_STEPS,
  MAX_EXPRESSION_SOURCE_LENGTH,
  RESERVED_BINDING_NAMES,
} from './limits.js'
export type { ParsedExpression } from './parser.js'
export { parseExpression } from './parser.js'
export type { Keyword, Punctuator, Token } from './tokenizer.js'
export { tokenize } from './tokenizer.js'
