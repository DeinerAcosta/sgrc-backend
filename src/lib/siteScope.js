import { errors } from './errors.js'

/**
 * AISLAMIENTO POR SEDE
 * ====================
 *
 * El coordinador trabaja sobre las sedes a las que está vinculado en
 * `usuarios_sedes`. El resto de roles con acceso a estos endpoints
 * (supervisor, gerencia, directivo) ven todo el sistema.
 *
 * El patrón ya existía en ejecucionController y en el cierre de semana, pero
 * nunca se había aplicado al CRUD de programación —crear, editar, borrar y
 * copiar asignaciones, y editar consultorios—, que es justamente donde más
 * importa: con el id de una asignación de otra ciudad, un coordinador podía
 * modificarla o borrarla.
 *
 * ESTE AISLAMIENTO CUBRE ESCRITURA, NO LECTURA — Y ES DELIBERADO.
 *
 * Un coordinador NO puede crear, editar, borrar ni copiar en una sede ajena
 * (403), pero SÍ ve las demás sedes y sus asignaciones. Decisión tomada el
 * 3-sep-2026, verificada con dos coordinadores de sedes disjuntas.
 *
 * El motivo: RN-08 (solape del mismo recurso) y RN-09 (una ciudad por día)
 * son reglas que cruzan sedes. Si un profesional ya está asignado el martes
 * en Cartagena, el coordinador de Barranquilla necesita VERLO para entender
 * por qué se le rechaza la asignación. Cerrando la lectura, el aviso de
 * conflicto queda sin contexto: "hay un choque" sin poder decir dónde.
 *
 * Si algún día se cierra, hay que dejar viva la consulta de disponibilidad
 * de un profesional concreto, o esos mensajes dejan de ser accionables.
 *
 * La lista de sedes sale de `req.user.sedes`, que desde el arreglo del
 * middleware de auth se relee de la base cada 60s. No hace falta consultar
 * nada aquí: quitarle una sede a alguien surte efecto en un minuto.
 *
 * NOTA: el modo de programación libre NO afecta a esto. Ese modo levanta el
 * CALENDARIO (semanas vencidas, sedes cerradas); los permisos por sede siguen
 * vigentes en todo momento.
 */

/** Roles que ven todas las sedes. */
const ROLES_GLOBALES = new Set(['supervisor', 'gerencia', 'directivo'])

/**
 * Sedes sobre las que puede actuar el usuario.
 * @returns {Set<string>|null} null = sin restricción (acceso global)
 */
export function sedesDeUsuario(user) {
  if (!user) return new Set()
  if (ROLES_GLOBALES.has(user.role)) return null
  return new Set(user.sites ?? [])
}

/** ¿Puede el usuario actuar sobre esta sede? */
export function puedeEnSede(user, sedeId) {
  const sedes = sedesDeUsuario(user)
  if (sedes === null) return true
  return !!sedeId && sedes.has(sedeId)
}

/**
 * Lanza 403 si el usuario no puede actuar sobre la sede indicada.
 *
 * El mensaje nombra la sede a propósito: un "no tienes permiso" seco deja al
 * coordinador sin saber si el problema es suyo o de su configuración. Si de
 * verdad debería tener acceso, lo que hay que revisar es su vínculo en
 * usuarios_sedes, y el mensaje se lo dice.
 */
export function assertSedePermitida(user, sedeId, nombreSede = null) {
  if (puedeEnSede(user, sedeId)) return
  const donde = nombreSede ? `la sede ${nombreSede}` : 'esa sede'
  throw errors.forbidden(
    `No estás vinculado a ${donde}, así que no puedes modificar su programación. ` +
    'Si deberías tener acceso, pide al supervisor que revise tus sedes asignadas.'
  )
}
