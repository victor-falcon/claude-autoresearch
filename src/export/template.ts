// Filling assets/template.html, as upstream's injectDataIntoTemplate. Pure.

export const TITLE_PLACEHOLDER = '__AUTORESEARCH_TITLE__'
export const LOGO_PLACEHOLDER = '__AUTORESEARCH_LOGO__'

/** `text` safe inside HTML text and quoted attribute values. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * The dashboard page: the session name (HTML-escaped) as its title and the
 * logo as a data URL for the share card. The logo goes in first so a session
 * name that spells a placeholder stays text; replacer functions keep `$&`
 * and friends in the values literal.
 */
export function injectDataIntoTemplate(template: string, title: string, logoDataUrl: string): string {
  const escapedTitle = escapeHtml(title)
  return template
    .replace(LOGO_PLACEHOLDER, () => logoDataUrl)
    .replace(TITLE_PLACEHOLDER, () => escapedTitle)
}
