import { z } from 'zod'

/**
 * Validación de las variables de entorno AL ARRANQUE.
 *
 * Antes el proceso levantaba igual aunque faltara JWT_SECRET: anunciaba
 * "escuchando en :3001", el health check respondía OK, y el fallo aparecía en el
 * primer intento de login como un 500 opaco. Un despliegue mal configurado
 * parecía sano.
 *
 * Ahora se comprueba antes de abrir el puerto y, si algo falta, el proceso
 * muere con un mensaje que dice exactamente qué arreglar. Es preferible no
 * arrancar a arrancar a medias.
 */

const esquema = z.object({
  DATABASE_URL: z.string().min(1, 'obligatoria — cadena de conexión a MySQL 8'),

  JWT_SECRET: z.string().min(32, 'obligatoria — mínimo 32 caracteres aleatorios'),
  REFRESH_SECRET: z.string().min(32, 'obligatoria — mínimo 32 caracteres aleatorios'),

  // Opcionales con valor por defecto: su ausencia no impide arrancar.
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  JWT_EXPIRES_IN: z.string().default('8h'),
  REFRESH_EXPIRES_IN: z.string().default('7d'),
  FRONTEND_ORIGIN: z.string().default('http://localhost:5173'),
  RATE_LIMIT_LOGIN: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_GLOBAL: z.coerce.number().int().positive().default(600),
})

/**
 * Valida process.env. Devuelve los valores ya normalizados.
 * Lanza con un mensaje legible si algo falta o está mal.
 */
export function validarEntorno(entorno = process.env) {
  const r = esquema.safeParse(entorno)

  if (!r.success) {
    const detalle = r.error.issues
      .map((i) => `  · ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(
      `No se puede arrancar: faltan o son inválidas estas variables de entorno.\n${detalle}\n\n` +
      'Cópialas de backend/.env.example a backend/.env y rellénalas.'
    )
  }

  const env = r.data
  const avisos = []

  // Los dos secretos deben ser distintos: si coinciden, un refresh token vale
  // como access token y la caducidad de 8h deja de significar nada.
  if (env.JWT_SECRET === env.REFRESH_SECRET) {
    avisos.push('JWT_SECRET y REFRESH_SECRET son iguales — deben ser secretos distintos.')
  }

  // En producción, no arrancar con los valores de ejemplo del repositorio.
  if (env.NODE_ENV === 'production') {
    for (const clave of ['JWT_SECRET', 'REFRESH_SECRET']) {
      if (env[clave].includes('cambiar-este') || env[clave].includes('otro-secret-distinto')) {
        throw new Error(
          `No se puede arrancar en producción: ${clave} sigue teniendo el valor de ejemplo de .env.example. ` +
          'Genera uno aleatorio (por ejemplo: openssl rand -base64 48).'
        )
      }
    }
  }

  return { env, avisos }
}
