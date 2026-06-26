/**
 * @file Representative benchmark inputs (lexer / parser / render / macro / analyze).
 *
 * Templates are built by repeating a small, realistic block so the inputs are sizable but
 * deterministic. Kept separate from the runner so the same fixtures can be reused.
 */

/**
 * A render-oriented block: references (resolved from `values`), a method call, arithmetic
 * and a lazy ternary — i.e. the common evaluator paths.
 */
const RENDER_BLOCK =
  'Hello ${ name.upper() }, you have ${ count + 1 } new messages ' +
  "(${ count > 3 ? 'many' : 'few' }). Total: ${ (count * 2) - 1 }.\n";

/** A parser-oriented block: nested calls, object/array literals, member access, match. */
const PARSE_BLOCK =
  "${ require({ id:'u', type: array().constraints({ values:['a','b','c'] }), capability:'user' }) } " +
  "${ x match { 1 => 'one', 2 => 'two', * => 'other' } } " +
  '${ (a + b) * (c - d) / 2 } ${ o.field.sub } ${ [1, 2, 3].sum() }\n';

/** A text-heavy block (lexer): mostly verbatim text with a couple of slots and a comment. */
const TEXT_BLOCK =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ' +
  'Sed do eiusmod tempor incididunt ut labore. #{ a note } ' +
  'Value ${ count } and name ${ name } in the middle of prose.\n';

/** @param {string} block @param {number} times @returns {string} */
function repeat(block, times) {
  return block.repeat(times);
}

/**
 * Builds the benchmark fixtures at a given scale.
 * @param {number} [scale=120]  How many times each block is repeated.
 */
export function buildCases(scale = 120) {
  const renderTemplate = repeat(RENDER_BLOCK, scale);
  const parseTemplate = repeat(PARSE_BLOCK, scale);
  const textTemplate = repeat(TEXT_BLOCK, scale);

  // Macro fixture: a main template that ABSORBs a part and carries layout markers, plus a
  // MERGE over several parts. Exercises expand (pre-pass) + run + finalize (post-pass).
  /** @type {Record<string, string>} */
  const templates = { part: 'PART ${ count }\n', foot_1: 'F1', foot_2: 'F2', foot_3: 'F3' };
  const macroTemplate =
    repeat("@{ABSORB('part')}${ name }@{REMOVE_RIGHT(0)}\n${ count }@{REMOVE_LINE}\n", scale) +
    "@{MERGE('foot_*', '-')}";

  return {
    scale,
    values: { name: 'World', count: 5, x: 2, a: 10, b: 4, c: 8, d: 3, o: { field: { sub: 'ok' } } },
    renderTemplate,
    parseTemplate,
    textTemplate,
    macroTemplate,
    templates,
  };
}
