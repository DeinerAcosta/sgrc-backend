import { describe, it, expect } from 'vitest'
import {
  minutosBaseSemana,
  diasHabilesEnSemana,
  contarFestivosEnSemana,
  esDomingoOFestivo,
  contarMesesEnRango,
  BASE_MINUTOS_SEMANA_TEORICA,
  MINUTOS_DIA_LV,
  MINUTOS_SABADO,
  DIAS_LABORABLES_SEMANA,
  deadlineCierreSemana,
  proximoDiaHabil,
} from './calendario.js'

// Semana referencia: dom 6-sep-2026 → sab 12-sep-2026 (RN-04: la semana arranca domingo).
const semana = {
  startDate: new Date('2026-09-06T00:00:00Z'),  // domingo
  endDate:   new Date('2026-09-12T00:00:00Z'),  // sabado
}

describe('minutosBaseSemana', () => {
  it('sin festivos devuelve la base teorica (3840 min = 64h)', () => {
    expect(minutosBaseSemana(semana, new Set())).toBe(BASE_MINUTOS_SEMANA_TEORICA)
    expect(BASE_MINUTOS_SEMANA_TEORICA).toBe(5 * MINUTOS_DIA_LV + MINUTOS_SABADO)
  })

  it('un festivo en lunes descuenta 720 min', () => {
    const f = new Set(['2026-09-07'])  // lunes
    expect(minutosBaseSemana(semana, f)).toBe(BASE_MINUTOS_SEMANA_TEORICA - MINUTOS_DIA_LV)
  })

  it('un festivo en sabado descuenta 240 min', () => {
    const f = new Set(['2026-09-12'])  // sabado
    expect(minutosBaseSemana(semana, f)).toBe(BASE_MINUTOS_SEMANA_TEORICA - MINUTOS_SABADO)
  })

  it('un festivo en domingo NO descuenta (ya esta fuera de la base)', () => {
    const f = new Set(['2026-09-06'])  // domingo
    expect(minutosBaseSemana(semana, f)).toBe(BASE_MINUTOS_SEMANA_TEORICA)
  })

  it('dos festivos LV suman ambos descuentos', () => {
    const f = new Set(['2026-09-07', '2026-09-08'])  // lu + ma
    expect(minutosBaseSemana(semana, f)).toBe(BASE_MINUTOS_SEMANA_TEORICA - 2 * MINUTOS_DIA_LV)
  })

  it('semana 100% festiva devuelve 0 (nunca negativo)', () => {
    const f = new Set(['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12'])
    expect(minutosBaseSemana(semana, f)).toBe(0)
  })

  it('devuelve 0 si la semana es null (para que los callers detecten "sin semana")', () => {
    expect(minutosBaseSemana(null, new Set())).toBe(0)
    expect(minutosBaseSemana(undefined, new Set())).toBe(0)
  })

  it('es idempotente: correr 2 veces con el mismo set da el mismo resultado', () => {
    const f = new Set(['2026-09-07'])
    const r1 = minutosBaseSemana(semana, f)
    const r2 = minutosBaseSemana(semana, f)
    expect(r1).toBe(r2)
    expect(f.size).toBe(1)  // no muta
  })
})

describe('diasHabilesEnSemana', () => {
  it('sin festivos son 6 (L-S)', () => {
    expect(diasHabilesEnSemana(semana, new Set())).toBe(DIAS_LABORABLES_SEMANA)
  })

  it('un festivo LV recorta a 5', () => {
    expect(diasHabilesEnSemana(semana, new Set(['2026-09-07']))).toBe(5)
  })

  it('festivo en domingo NO cuenta', () => {
    expect(diasHabilesEnSemana(semana, new Set(['2026-09-06']))).toBe(6)
  })

  it('semana null devuelve 0 (para que los callers detecten "sin semana")', () => {
    expect(diasHabilesEnSemana(null, new Set())).toBe(0)
  })
})

describe('contarFestivosEnSemana', () => {
  it('separa LV y sabado', () => {
    const f = new Set(['2026-09-07', '2026-09-12'])  // lunes + sabado
    expect(contarFestivosEnSemana(semana, f)).toEqual({ lv: 1, sab: 1 })
  })

  it('devuelve 0/0 sin festivos', () => {
    expect(contarFestivosEnSemana(semana, new Set())).toEqual({ lv: 0, sab: 0 })
  })
})

describe('esDomingoOFestivo', () => {
  it('domingo puro (dow=0) es true aunque no este en el set', () => {
    expect(esDomingoOFestivo('2026-09-06', new Set())).toBe(true)
    expect(esDomingoOFestivo('2026-09-13', new Set())).toBe(true)
  })

  it('festivo LV en set es true', () => {
    expect(esDomingoOFestivo('2026-09-07', new Set(['2026-09-07']))).toBe(true)
  })

  it('dia normal es false', () => {
    expect(esDomingoOFestivo('2026-09-08', new Set())).toBe(false)  // martes
    expect(esDomingoOFestivo('2026-09-12', new Set())).toBe(false)  // sabado normal
  })

  it('acepta Date', () => {
    expect(esDomingoOFestivo(new Date('2026-09-13T00:00:00Z'), new Set())).toBe(true)
  })

  it('null / undefined / invalido devuelve false', () => {
    expect(esDomingoOFestivo(null, new Set())).toBe(false)
    expect(esDomingoOFestivo(undefined, new Set())).toBe(false)
    expect(esDomingoOFestivo('nada', new Set())).toBe(false)
  })
})

describe('contarMesesEnRango', () => {
  it('mismo mes → 1', () => {
    expect(contarMesesEnRango('2026-09-01', '2026-09-30')).toBe(1)
  })

  it('sep-oct → 2', () => {
    expect(contarMesesEnRango('2026-09-15', '2026-10-15')).toBe(2)
  })

  it('sep-dic mismo anio → 4', () => {
    expect(contarMesesEnRango('2026-09-01', '2026-12-31')).toBe(4)
  })

  it('cruza fin de anio: dic-2026 a ene-2027 → 2', () => {
    expect(contarMesesEnRango('2026-12-15', '2027-01-15')).toBe(2)
  })

  it('un solo dia → 1', () => {
    expect(contarMesesEnRango('2026-09-07', '2026-09-07')).toBe(1)
  })

  it('null → 1 (evita division por cero)', () => {
    expect(contarMesesEnRango(null, null)).toBe(1)
    expect(contarMesesEnRango('2026-09-01', null)).toBe(1)
  })
})

// ============================================================================
// PLAZO DE CIERRE CON FESTIVOS
//
// Oct-2026 · Hector: "¿por que se cerro la semana si cuando hay un festivo
// cierra al dia siguiente?". Tenia razon. La regla estaba escrita en un
// comentario de jobs/autoCloseWeek.js pero el codigo restaba 2 dias de
// CALENDARIO, asi que el lunes festivo contaba como dia habil de plazo.
//
// El caso real esta reproducido abajo tal cual paso en produccion.
// ============================================================================
const iso = (d) => new Date(d).toISOString()
const domingo = (s) => new Date(s + 'T00:00:00.000Z')

describe('proximoDiaHabil', () => {
  it('un dia habil se devuelve igual', () => {
    expect(iso(proximoDiaHabil(domingo('2026-10-13')))).toBe('2026-10-13T00:00:00.000Z')  // martes
  })

  it('salta el domingo', () => {
    // 2026-10-11 es domingo -> lunes 12
    expect(iso(proximoDiaHabil(domingo('2026-10-11')))).toBe('2026-10-12T00:00:00.000Z')
  })

  it('salta un festivo', () => {
    const fest = new Set(['2026-10-12'])
    expect(iso(proximoDiaHabil(domingo('2026-10-12'), fest))).toBe('2026-10-13T00:00:00.000Z')
  })

  it('salta varios festivos seguidos', () => {
    const fest = new Set(['2026-10-12', '2026-10-13', '2026-10-14'])
    expect(iso(proximoDiaHabil(domingo('2026-10-12'), fest))).toBe('2026-10-15T00:00:00.000Z')
  })

  it('el sabado SI es habil: la clinica atiende', () => {
    // 2026-10-17 es sabado
    expect(iso(proximoDiaHabil(domingo('2026-10-17')))).toBe('2026-10-17T00:00:00.000Z')
  })

  it('no se cuelga si alguien carga un rango absurdo de festivos', () => {
    const fest = new Set()
    for (let i = 0; i < 40; i++) {
      const d = new Date('2026-10-12T00:00:00.000Z'); d.setUTCDate(d.getUTCDate() + i)
      fest.add(d.toISOString().slice(0, 10))
    }
    expect(() => proximoDiaHabil(domingo('2026-10-12'), fest)).not.toThrow()
  })
})

describe('deadlineCierreSemana', () => {
  // 23:59:59 de Bogota = 04:59:59 UTC del dia siguiente (UTC-5 fijo).
  it('semana normal: vence el lunes 23:59 de Bogota', () => {
    // semana que termina domingo 2026-10-04 -> plazo lunes 5
    expect(iso(deadlineCierreSemana(domingo('2026-10-04')))).toBe('2026-10-06T04:59:59.000Z')
  })

  it('EL CASO REAL: lunes 12-oct festivo -> el plazo corre al martes 13', () => {
    const fest = new Set(['2026-10-12'])
    const plazo = deadlineCierreSemana(domingo('2026-10-11'), fest)
    // martes 13 a las 23:59 Bogota = miercoles 14 a las 04:59:59 UTC
    expect(iso(plazo)).toBe('2026-10-14T04:59:59.000Z')
  })

  it('y sin el festivo cargado, la MISMA semana vencia el lunes', () => {
    // Deja claro que lo unico que cambia el resultado es el festivo.
    expect(iso(deadlineCierreSemana(domingo('2026-10-11')))).toBe('2026-10-13T04:59:59.000Z')
  })

  it('el job de hoy martes 13 a medianoche NO debia cerrar esa semana', () => {
    // Reproduce exactamente lo que paso: el cron corre 00:00 Bogota del martes
    // 13 = 05:00 UTC. Con el festivo cargado, el plazo aun no habia vencido.
    const fest = new Set(['2026-10-12'])
    const cronMartes = new Date('2026-10-13T05:00:00.000Z')
    const plazo = deadlineCierreSemana(domingo('2026-10-11'), fest)
    expect(cronMartes.getTime() > plazo.getTime()).toBe(false)
  })

  it('y el miercoles 14 a medianoche SI debe cerrarla', () => {
    const fest = new Set(['2026-10-12'])
    const cronMiercoles = new Date('2026-10-14T05:00:00.000Z')
    const plazo = deadlineCierreSemana(domingo('2026-10-11'), fest)
    expect(cronMiercoles.getTime() > plazo.getTime()).toBe(true)
  })

  it('dos festivos seguidos corren el plazo dos dias', () => {
    const fest = new Set(['2026-10-12', '2026-10-13'])
    expect(iso(deadlineCierreSemana(domingo('2026-10-11'), fest))).toBe('2026-10-15T04:59:59.000Z')
  })

  it('el plazo cae a las 23:59 de Bogota, no a las 18:59', () => {
    // El servidor corre en UTC. Antes se hacia setHours(23,59,59) sobre UTC y
    // el cierre quedaba registrado a las 18:59 hora de Colombia.
    const plazo = deadlineCierreSemana(domingo('2026-10-04'))
    const enBogota = plazo.toLocaleString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false })
    expect(enBogota).toBe('23:59')
  })
})
