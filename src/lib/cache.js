// Caché en memoria con TTL.
//
// Objetivo: cuando muchos usuarios abren a la vez los informes/dashboard (lecturas
// analíticas pesadas), no recalcular lo mismo una y otra vez. Con 100 usuarios
// concurrentes pasamos de ~100 cálculos a 1 cálculo cada `ttl` segundos.
//
// Es un caché POR INSTANCIA: si hay varias réplicas en producción, cada una tiene
// el suyo (perfectamente válido). Para datos que deban ser instantáneamente
// consistentes (programación, ejecución) NO se usa — solo para informes.

const store = new Map()

/**
 * Devuelve el valor cacheado para `key` si no expiró. Si no, ejecuta `fn`, guarda
 * el resultado con TTL y lo devuelve.
 *
 * Anti-stampede: si llegan N peticiones concurrentes con la misma key estando el
 * caché frío, solo se ejecuta `fn` UNA vez y las N comparten la misma promesa.
 * Esto evita que 100 usuarios disparen 100 cálculos idénticos a la vez.
 */
export async function withCache(key, ttlMs, fn) {
  const now = Date.now()
  const hit = store.get(key)
  if (hit && hit.expira > now) {
    return hit.promesa ?? hit.valor
  }

  const promesa = Promise.resolve().then(fn)
  // Guardamos la promesa en vuelo para que las llamadas concurrentes la reutilicen
  store.set(key, { promesa, expira: now + ttlMs })

  try {
    const valor = await promesa
    store.set(key, { valor, expira: now + ttlMs })
    return valor
  } catch (e) {
    store.delete(key) // nunca cachear errores
    throw e
  }
}

/** Construye una key estable a partir de un objeto de filtros (orden independiente). */
export function keyDeQuery(prefijo, query = {}) {
  const limpio = {}
  for (const k of Object.keys(query).sort()) {
    const v = query[k]
    if (v !== undefined && v !== null && v !== '') limpio[k] = v
  }
  return `${prefijo}:${JSON.stringify(limpio)}`
}

/** Elimina entradas expiradas para que el Map no crezca indefinidamente. */
export function limpiarCacheExpirado() {
  const now = Date.now()
  for (const [k, v] of store.entries()) {
    if (v.expira <= now) store.delete(k)
  }
}

/** Vacía todo el caché (útil en tests o tras una operación masiva). */
export function invalidarCache() {
  store.clear()
}
