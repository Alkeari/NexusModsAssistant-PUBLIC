/**
 * One accessor for every user-facing string, so no module reaches into chrome.i18n directly and a
 * missing key is loud instead of silent.
 *
 * chrome.i18n.getMessage returns an empty string for a key that is not in the catalog, which on a
 * button reads as a blank control rather than as a bug. Here a miss returns the key itself and warns
 * once, so it shows up in the UI and in the console during review instead of shipping as a gap.
 */
const missing = new Set<string>();

export function t(key: string, substitutions?: string | string[]): string {
    const text = chrome.i18n.getMessage(key, substitutions);
    if (text) {
        return text;
    }
    if (!missing.has(key)) {
        missing.add(key);
        console.warn('NMA i18n: no message for key "' + key + '"');
    }
    return key;
}

/**
 * The same lookup, escaped for interpolation into an HTML template.
 *
 * The on-page panel builds its bars with innerHTML, so catalog text lands inside markup and inside
 * attribute values. In English every string happens to be safe; a translation is not something this
 * codebase controls, and one double quote in a title would end the attribute early while one angle
 * bracket in body text would open a tag. Use this anywhere a message goes into a template string,
 * and `t` only where it is assigned to textContent.
 */
export function tHtml(key: string, substitutions?: string | string[]): string {
    return t(key, substitutions)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Fills every element carrying data-i18n from the catalog. `data-i18n` sets textContent;
 * `data-i18n-title`, `data-i18n-placeholder` and `data-i18n-aria-label` set those attributes, so a
 * tooltip or a placeholder is translated without a second lookup at each call site.
 */
export function applyStaticStrings(root: ParentNode = document): void {
    root.querySelectorAll<HTMLElement>('[data-i18n]').forEach(el => {
        el.textContent = t(el.dataset.i18n as string);
    });
    const attributes: Array<[string, string]> = [
        ['data-i18n-title', 'title'],
        ['data-i18n-placeholder', 'placeholder'],
        ['data-i18n-aria-label', 'aria-label'],
    ];
    for (const [dataAttribute, target] of attributes) {
        root.querySelectorAll<HTMLElement>('[' + dataAttribute + ']').forEach(el => {
            el.setAttribute(target, t(el.getAttribute(dataAttribute) as string));
        });
    }
}
