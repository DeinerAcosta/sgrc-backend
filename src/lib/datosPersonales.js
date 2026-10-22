/**
 * Autorización de tratamiento de datos personales al registrar una ausencia
 * (PROYECTOS-3398 §3 · 3642/3643).
 *
 * Oct-2026 · Hector: la "declaración jurídica" es la casilla de datos
 * personales, con el enlace a la política de VIU. La acepta el profesional
 * cuando registra su PROPIA ausencia: el titular de los datos es él, nadie lo
 * puede autorizar en su nombre (si la registra el coordinador, no se pide).
 *
 * Se guarda la VERSIÓN del texto, no un sí/no: el día que cambie la redacción
 * hay que poder decir qué aceptó cada quien. Si se cambia `texto` o `url`, se
 * sube `version`.
 */
export const AUTORIZACION_DATOS = Object.freeze({
  version: 'datos-personales-v1-2026-10',
  texto:
    'Autorizo a VIU Clínica Oftalmológica Internacional (COFCA) para el tratamiento de mis datos personales, ' +
    'conforme a la Ley 1581 de 2012 y a su Política de Protección de Datos Personales.',
  url: 'https://viuoftalmologia.com/proteccion-de-datos-personales/',
})

/** El rol que registra su propia ausencia y por eso tiene que autorizar. */
export const pideAutorizacionDatos = (rol) => rol === 'recurso'
