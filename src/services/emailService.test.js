import { describe, it, expect } from 'vitest'
import { errorTemporal } from './emailService.js'

describe('errorTemporal', () => {
  it('reintenta los 4xx de Gmail (demasiados inicios de sesión, rechazo temporal)', () => {
    expect(errorTemporal({ responseCode: 454 })).toBe(true)
    expect(errorTemporal({ responseCode: 451 })).toBe(true)
    expect(errorTemporal({ responseCode: 421 })).toBe(true)
  })

  it('reintenta la conexión caída', () => {
    expect(errorTemporal({ code: 'ECONNECTION' })).toBe(true)
    expect(errorTemporal({ code: 'ETIMEDOUT' })).toBe(true)
  })

  it('no reintenta los errores definitivos (5xx: buzón inexistente, credenciales malas)', () => {
    expect(errorTemporal({ responseCode: 550 })).toBe(false)
    expect(errorTemporal({ responseCode: 535 })).toBe(false)
    expect(errorTemporal({ code: 'EAUTH' })).toBe(false)
    expect(errorTemporal(undefined)).toBe(false)
  })
})
