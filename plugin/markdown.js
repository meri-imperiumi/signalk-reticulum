/**
 * Markdown shaping for LXMF command replies.
 *
 * LXMF carries a `FIELD_RENDERER` field (§5.9.4) that tells clients such as
 * Sideband to render message content as Markdown
 * (`RENDERER_MARKDOWN`). The mesh deliverer attaches that field when a
 * command asks for `markdown`, and these helpers shape the shared plain lines
 * into Markdown for the reply — bold labels and bold section headings. The
 * wording stays identical to the plain lines the NomadNet pages render, so
 * the two views cannot drift apart; only the emphasis differs per medium.
 *
 * The output deliberately stays readable as plain text: a client that
 * ignores the renderer field shows the raw asterisks, which read fine.
 *
 * @file markdown.js
 */

/**
 * A leading glyph (the briefing webapp's timeline marks: ⚠ 🔋 ☾ ✦ ☀ ☽) kept
 * outside a bolded label.
 */
const GLYPH_PREFIX = "(?:⚠|🔋|☾|☽|✦|☀)\\s";

/**
 * Bolds a line's leading `Label:` — "**Depth:** 5.2 m below surface". An
 * optional leading glyph stays unbolded in front. Lines without a short
 * leading label pass through untouched, so prose lines like "Vessel is
 * anchored" keep their shape.
 *
 * @param {string} line
 * @returns {string}
 */
function boldLabel(line) {
  const match = new RegExp(
    `^(${GLYPH_PREFIX})?([A-Za-z][A-Za-z0-9 ']{0,30}):\\s(.+)$`,
  ).exec(line);
  return match ? `${match[1] ?? ""}**${match[2]}:** ${match[3]}` : line;
}

/**
 * Bolds a section-label line — "Warnings:" → "**Warnings**", "⚠ Hazards:" →
 * "**⚠ Hazards**". Anything that is not a bare label line passes through
 * untouched.
 *
 * @param {string} line
 * @returns {string}
 */
function boldHeading(line) {
  const match = new RegExp(
    `^(${GLYPH_PREFIX})?([A-Za-z][A-Za-z0-9 ']{0,30}):$`,
  ).exec(line);
  return match ? `${match[1] ?? ""}**${match[2]}**` : line;
}

/**
 * Renders one shared plain line as Markdown: bare section labels become bold
 * headings, everything else gets a bolded leading label when it has one.
 *
 * @param {string} line
 * @returns {string}
 */
function markdownize(line) {
  return boldHeading(boldLabel(line));
}

/**
 * Joins rendered lines into a Markdown body with a **hard line break**
 * (CommonMark: two trailing spaces before the newline) instead of a bare
 * newline. A bare newline is a *soft* break, which Markdown renderers collapse
 * into a space — Columba's renderer (multiplatform-markdown-renderer, default
 * `eolAsNewLine: false`) and Sideband's both turn `a\nb` into `a b`, which
 * jumbled every label-value line of a Status reply onto one line. A hard break
 * renders as a real line break in every CommonMark client, and stays invisible
 * in the plain-text fallback (trailing spaces don't show).
 *
 * @param {string[]} lines
 * @returns {string}
 */
function markdownJoin(lines) {
  return lines.join("  \n");
}

module.exports = {
  boldLabel,
  boldHeading,
  markdownize,
  markdownJoin,
};
