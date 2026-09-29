import { describe, it, expect } from 'vitest'
import { fechaSolo, fechaSoloCorta, periodo, fechaHora } from './fechas.js'

// El caso exacto que se vio en produccion: la semana del 21 al 27 de septiembre
// de 2026 salia en el correo de cierre automatico como "20 de septiembre — 26
// de septiembre". Prisma guarda esas fechas a medianoche UTC y el correo las
// formateaba en America/Bogota (UTC-5), que las corre al dia anterior.
const LUNES_21 = new Date('2026-09-21T00:00:00.000Z')
const DOMINGO_27 = new Date('2026-09-27T00:00:00.000Z')

describe('fechaSolo — un dia del calendario no se corre', () => {
  it('la medianoche UTC se muestra como ESE dia, no el anterior', () => {
    expect(fechaSolo(LUNES_21)).toBe('21 de septiembre de 2026')
    expect(fechaSolo(DOMINGO_27)).toBe('27 de septiembre de 2026')
  })

  it('reproduce el bug: formatear en Bogota daba el dia anterior', () => {
    const conBug = LUNES_21.toLocaleDateString('es-CO', {
      day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/Bogota',
    })
    expect(conBug).toBe('20 de septiembre de 2026')   // lo que decia el correo
    expect(fechaSolo(LUNES_21)).not.toBe(conBug)      // lo que dice ahora
  })

  it('aguanta el cambio de mes y de año', () => {
    expect(fechaSolo(new Date('2026-10-01T00:00:00.000Z'))).toBe('01 de octubre de 2026')
    expect(fechaSolo(new Date('2027-01-01T00:00:00.000Z'))).toBe('01 de enero de 2027')
  })

  it('acepta string ISO igual que Date', () => {
    expect(fechaSolo('2026-09-21T00:00:00.000Z')).toBe(fechaSolo(LUNES_21))
  })

  it('sin fecha devuelve raya, no "Invalid Date"', () => {
    expect(fechaSolo(null)).toBe('—')
    expect(fechaSolo(undefined)).toBe('—')
  })
})

describe('fechaSoloCorta', () => {
  it('usa el mismo criterio de zona', () => {
    expect(fechaSoloCorta(LUNES_21)).toBe('21/09/2026')
  })
})

describe('periodo', () => {
  it('une dos dias distintos', () => {
    expect(periodo(LUNES_21, DOMINGO_27))
      .toBe('21 de septiembre de 2026 al 27 de septiembre de 2026')
  })

  it('una ausencia de un solo dia no se repite', () => {
    expect(periodo(LUNES_21, LUNES_21)).toBe('21 de septiembre de 2026')
  })
})

describe('fechaHora — un instante SI va en hora Colombia', () => {
  it('un cierre a las 02:32 UTC salio el dia anterior a las 21:32 en Colombia', () => {
    // Caso real: weekSiteClosure.closedAt = 2026-09-29T02:32:36.948Z
    const texto = fechaHora(new Date('2026-09-29T02:32:36.948Z'))
    expect(texto).toContain('28 de septiembre de 2026')
    expect(texto).toMatch(/9:32/)
  })

  it('sin fecha devuelve raya', () => {
    expect(fechaHora(null)).toBe('—')
  })
})
