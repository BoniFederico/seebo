/**
 * @file Public contract for the AST (IMPL §3.1). The AST is the public contract between
 * the parser and {validate, analyze, run}, and between backend and frontend. Source of
 * truth for node shapes and kinds. No logic here (factories live in {@link ./index.js}).
 *
 * Grammar shapes (IMPL §3.1):
 *   Document = { astVersion, nodes: Node[] }
 *   Node     = Text | Formula | Comment | Macro
 *   Expr     = Lit | Ref | Call | Method | Member | Unary | Binary | Ternary | Namespace
 */

/**
 * Document-level node kinds (IMPL §3.1).
 * @type {Readonly<Record<string, string>>}
 */
export const NodeKind = Object.freeze({
  TEXT: 'Text',
  FORMULA: 'Formula',
  COMMENT: 'Comment',
  MACRO: 'Macro',
});

/**
 * Expression node kinds (IMPL §3.1).
 * @type {Readonly<Record<string, string>>}
 */
export const ExprKind = Object.freeze({
  LIT: 'Lit',
  REF: 'Ref',
  CALL: 'Call',
  METHOD: 'Method',
  MEMBER: 'Member',
  UNARY: 'Unary',
  BINARY: 'Binary',
  TERNARY: 'Ternary',
  NAMESPACE: 'Namespace',
  OBJECT_LIT: 'ObjectLit',
  ARRAY_LIT: 'ArrayLit',
});

/**
 * @typedef {import('../lexer/tokens.js').Position} Position
 */

/* ----------------------------------------------------------------------------------- *
 * Document and nodes
 * ----------------------------------------------------------------------------------- */

/**
 * Root of the AST (IMPL §3.1). Carries the contract version.
 * @typedef {Object} Document
 * @property {number} astVersion
 * @property {Node[]} nodes
 */

/**
 * Union of document-level nodes.
 * @typedef {TextNode | FormulaNode | CommentNode | MacroNode} Node
 */

/**
 * Verbatim text copied straight through (IMPL §2).
 * @typedef {Object} TextNode
 * @property {'Text'} kind
 * @property {Position} position
 * @property {string} value
 */

/**
 * A `${ ... }` slot whose expression is evaluated and stringified at emission (SPEC §1.2).
 * @typedef {Object} FormulaNode
 * @property {'Formula'} kind
 * @property {Position} position
 * @property {Expr} expr
 */

/**
 * A `#{ ... }` comment slot, removed at emission (SPEC §1.2).
 * @typedef {Object} CommentNode
 * @property {'Comment'} kind
 * @property {Position} position
 */

/**
 * A `@{ ... }` macro slot (SPEC §1.8). `family` distinguishes pre-pass aggregators from
 * post-pass layout macros.
 * @typedef {Object} MacroNode
 * @property {'Macro'} kind
 * @property {Position} position
 * @property {string} name
 * @property {Expr[]} args
 * @property {'aggregator'|'layout'} family
 */

/* ----------------------------------------------------------------------------------- *
 * Expressions
 * ----------------------------------------------------------------------------------- */

/**
 * Union of expression nodes (IMPL §3.1, extended with object/array literals which the
 * grammar uses as producer arguments and choice-list values, SPEC §1.3/§1.5/§1.7).
 * @typedef {LitNode | RefNode | CallNode | MethodNode | MemberNode | UnaryNode | BinaryNode | TernaryNode | NamespaceNode | ObjectLitNode | ArrayLitNode} Expr
 */

/**
 * Literal value (SPEC §1.4). `type` is one of the base Seebo types parseable as a literal.
 * @typedef {Object} LitNode
 * @property {'Lit'} kind
 * @property {Position} position
 * @property {string} type
 * @property {unknown} value
 */

/**
 * Reference to a declared `var`/`require` by name (SPEC §1.7).
 * @typedef {Object} RefNode
 * @property {'Ref'} kind
 * @property {Position} position
 * @property {string} name
 */

/**
 * Producer call `name(...)` (SPEC §1.5). Capability calls are normalized into `require`
 * at parse time (IMPL §3), so `callee` here is a producer/require name.
 * @typedef {Object} CallNode
 * @property {'Call'} kind
 * @property {Position} position
 * @property {string} callee
 * @property {Expr[]} args
 */

/**
 * Transformer method `receiver.name(...)` (SPEC §1.5).
 * @typedef {Object} MethodNode
 * @property {'Method'} kind
 * @property {Position} position
 * @property {Expr} receiver
 * @property {string} name
 * @property {Expr[]} args
 */

/**
 * Member access `receiver.key` on an object (SPEC §1.5).
 * @typedef {Object} MemberNode
 * @property {'Member'} kind
 * @property {Position} position
 * @property {Expr} receiver
 * @property {string} key
 */

/**
 * Prefix unary expression: `not x`, `-x` (SPEC §1.4, level 2).
 * @typedef {Object} UnaryNode
 * @property {'Unary'} kind
 * @property {Position} position
 * @property {string} op
 * @property {Expr} arg
 */

/**
 * Infix binary expression (SPEC §1.4 / IMPL §3 precedence table). `match` and the
 * coalesce/logical operators are desugared into Binary/Ternary at parse time.
 * @typedef {Object} BinaryNode
 * @property {'Binary'} kind
 * @property {Position} position
 * @property {string} op
 * @property {Expr} left
 * @property {Expr} right
 */

/**
 * Ternary `cond ? then : else` (SPEC §1.4, level 10). `match` desugars into nested
 * ternaries (IMPL §3).
 * @typedef {Object} TernaryNode
 * @property {'Ternary'} kind
 * @property {Position} position
 * @property {Expr} cond
 * @property {Expr} then
 * @property {Expr} else
 */

/**
 * Namespace/library call `ns.name(...)`, e.g. `fake.email()` (SPEC §1.5, IMPL §3.1).
 * @typedef {Object} NamespaceNode
 * @property {'Namespace'} kind
 * @property {Position} position
 * @property {string} ns
 * @property {string} name
 * @property {Expr[]} args
 */

/**
 * Object literal `{ key: expr, ... }` (SPEC §1.5/§1.6 descriptors, §1.3 format/constraints).
 * Keys are static identifiers (or string keys); values are arbitrary expressions.
 * @typedef {Object} ObjectEntry
 * @property {string} key
 * @property {Expr} value
 */

/**
 * Object literal node.
 * @typedef {Object} ObjectLitNode
 * @property {'ObjectLit'} kind
 * @property {Position} position
 * @property {ObjectEntry[]} entries
 */

/**
 * Array literal `[expr, ...]` (SPEC §1.5 `array([...])`, §1.7 choice-list values).
 * @typedef {Object} ArrayLitNode
 * @property {'ArrayLit'} kind
 * @property {Position} position
 * @property {Expr[]} elements
 */
