/**
 * AST for the safe expression mini-language.
 *
 * SECURITY BY CONSTRUCTION (spec §4 rule 3): there is deliberately NO member
 * node, NO index node, NO assignment node and NO lambda/function node in this
 * union. `a.b`, `a["b"]`, `a = b` and `() => …` are therefore UNREPRESENTABLE —
 * `__proto__` / `constructor` / `prototype` traversal is impossible at the type
 * level, not by a runtime denylist. `ExpressionCallNode.callee` is a plain
 * string (a builtin name), never a node, so a computed call like `(min)(1)` is
 * unparseable.
 *
 * The value domain is the four JSON primitives — no objects, arrays or
 * functions ever flow through the evaluator.
 */

/** The only value types the engine produces or consumes. */
export type ExpressionValue = number | string | boolean | null
/** Stable structural address of a node within one parsed expression AST. */
export type ExpressionNodePath = string

export type ExpressionBinaryOperator =
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
export type ExpressionLogicalOperator = '&&' | '||'
export type ExpressionUnaryOperator = '-' | '!'

export interface ExpressionLiteralNode {
  readonly kind: 'literal'
  readonly value: ExpressionValue
}
export interface ExpressionIdentifierNode {
  readonly kind: 'identifier'
  readonly name: string
}
export interface ExpressionUnaryNode {
  readonly kind: 'unary'
  readonly op: ExpressionUnaryOperator
  readonly operand: ExpressionNode
}
export interface ExpressionBinaryNode {
  readonly kind: 'binary'
  readonly op: ExpressionBinaryOperator
  readonly left: ExpressionNode
  readonly right: ExpressionNode
}
export interface ExpressionLogicalNode {
  readonly kind: 'logical'
  readonly op: ExpressionLogicalOperator
  readonly left: ExpressionNode
  readonly right: ExpressionNode
}
export interface ExpressionConditionalNode {
  readonly kind: 'conditional'
  readonly test: ExpressionNode
  readonly consequent: ExpressionNode
  readonly alternate: ExpressionNode
}
export interface ExpressionCallNode {
  readonly kind: 'call'
  readonly callee: string
  readonly args: readonly ExpressionNode[]
}

export type ExpressionNode =
  | ExpressionLiteralNode
  | ExpressionIdentifierNode
  | ExpressionUnaryNode
  | ExpressionBinaryNode
  | ExpressionLogicalNode
  | ExpressionConditionalNode
  | ExpressionCallNode
