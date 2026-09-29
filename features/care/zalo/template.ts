/**
 * Renders a care message template. Only whitelisted placeholders are substituted; unknown
 * placeholders are left untouched so a typo never leaks another variable.
 */
export function renderCareTemplate(template: string, vars: { name: string }): string {
  return template.replace(/\{name\}/g, vars.name.trim() || 'Quý khách');
}
