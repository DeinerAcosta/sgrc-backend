/**
 * Helpers para normalizar strings que terminan visibles en la UI.
 * Misma lógica que `frontend/src/utils/helpers.js#titleCase` para mantener
 * la transformación coherente entre back y front.
 */

const PALABRAS_MINUSCULA = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'e', 'o', 'u', 'al', 'en'])

/**
 * Normaliza un nombre propio a Title Case: "ROSA MARTINEZ" o "rosa martinez"
 * → "Rosa Martinez". Mantiene conectores en minúscula ("Aida del Carmen"),
 * respeta tildes ("Érika") y separa por whitespace, `_` y `-`.
 *
 * Devuelve el valor tal cual si no es string (para tolerar undefined/null en
 * llamados encadenados).
 */
export function titleCase(str) {
  if (str === null || str === undefined) return str
  if (typeof str !== 'string') return str
  return str
    .toLowerCase()
    .split(/(\s+|[_-])/)
    .map((w, i) => {
      if (!w || /^\s+$/.test(w) || w === '_' || w === '-') return w === '_' ? ' ' : w
      if (i > 0 && PALABRAS_MINUSCULA.has(w)) return w
      if (/^\d+$/.test(w)) return w
      return w[0].toLocaleUpperCase('es-CO') + w.slice(1)
    })
    .join('')
    .trim()
    .replace(/\s+/g, ' ')
}
