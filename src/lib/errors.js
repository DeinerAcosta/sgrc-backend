// Errores HTTP semánticos alineados con la Especificación §5 y Diagrama 3
export class HttpError extends Error {
  constructor(status, message, extras = {}) {
    super(message)
    this.status = status
    this.extras = extras
  }
}

export const errors = {
  badRequest: (msg, extras) => new HttpError(400, msg, extras),
  unauthorized: (msg = 'No autenticado') => new HttpError(401, msg),
  forbidden: (msg = 'No tienes permiso') => new HttpError(403, msg),
  notFound: (msg = 'No encontrado') => new HttpError(404, msg),
  conflict: (msg, extras) => new HttpError(409, msg, extras),
  unprocessable: (msg, extras) => new HttpError(422, msg, extras),
  internal: (msg = 'Error interno') => new HttpError(500, msg),
}
