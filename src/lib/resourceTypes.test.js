import { describe, it, expect } from 'vitest'
import {
  normalizarEsquemaYTope,
  HORAS_SEMANA_POR_DEFECTO,
  TIPOS_POR_PACIENTE,
  ESQUEMAS_PAGO,
} from './resourceTypes.js'

// El invariante que estas pruebas protegen:
//
//   payScheme === 'por_paciente'  <=>  maxHoursPerWeek === null
//
// Vale la pena blindarlo con pruebas puras (sin BD) porque el estado que rompe
// este invariante NO da error en ninguna parte: se cuela hasta el informe de
// "Tiempos ociosos", donde un recurso con horas asignadas de verdad aparece al
// 0% de utilizacion. Es exactamente lo que paso con 94 oftalmologos en
// produccion, y nadie lo noto durante meses.

describe('normalizarEsquemaYTope — el invariante nunca se rompe', () => {
  it('por_paciente jamas conserva tope, aunque se lo pasen explicito', () => {
    const r = normalizarEsquemaYTope({ type: 'oftalmologo', payScheme: 'por_paciente', maxHoursPerWeek: 44 })
    expect(r).toEqual({ payScheme: 'por_paciente', maxHoursPerWeek: null })
  })

  it('fijo y mixto siempre salen con tope, aunque llegue null', () => {
    for (const esquema of ['fijo', 'mixto']) {
      const r = normalizarEsquemaYTope({ type: 'auxiliar', payScheme: esquema, maxHoursPerWeek: null })
      expect(r).toEqual({ payScheme: esquema, maxHoursPerWeek: HORAS_SEMANA_POR_DEFECTO })
    }
  })

  it('ninguna combinacion de entradas produce un estado incoherente', () => {
    const tipos = ['oftalmologo', 'fonoaudiologa', 'auxiliar', 'optometra', 'tecnico', undefined]
    const esquemas = [...ESQUEMAS_PAGO, undefined, null, '', 'basura']
    const topes = [null, undefined, 44, 42, 60]

    for (const type of tipos) {
      for (const payScheme of esquemas) {
        for (const maxHoursPerWeek of topes) {
          const r = normalizarEsquemaYTope({ type, payScheme, maxHoursPerWeek })
          if (r.payScheme === 'por_paciente') {
            expect(r.maxHoursPerWeek, `${type}/${payScheme}/${maxHoursPerWeek}`).toBeNull()
          } else {
            expect(r.maxHoursPerWeek, `${type}/${payScheme}/${maxHoursPerWeek}`).toBeGreaterThan(0)
          }
          expect(ESQUEMAS_PAGO).toContain(r.payScheme)
        }
      }
    }
  })
})

describe('normalizarEsquemaYTope — el tipo solo aporta el defecto', () => {
  it('sin esquema declarado, los tipos por paciente salen como por_paciente', () => {
    for (const type of TIPOS_POR_PACIENTE) {
      expect(normalizarEsquemaYTope({ type })).toEqual({ payScheme: 'por_paciente', maxHoursPerWeek: null })
    }
  })

  it('sin esquema declarado, el resto sale fijo con la jornada de ley', () => {
    for (const type of ['auxiliar', 'tecnico', 'asesor_servicios', 'anestesiologo', 'otorrino', 'optometra']) {
      expect(normalizarEsquemaYTope({ type })).toEqual({
        payScheme: 'fijo',
        maxHoursPerWeek: HORAS_SEMANA_POR_DEFECTO,
      })
    }
  })

  it('con esquema declarado MANDA EL ESQUEMA, no el tipo', () => {
    // Este es el caso que la interfaz no permitia expresar: un oftalmologo de
    // salario fijo. Ahora es representable y coherente — con tope, no con NULL.
    expect(normalizarEsquemaYTope({ type: 'oftalmologo', payScheme: 'fijo' })).toEqual({
      payScheme: 'fijo',
      maxHoursPerWeek: HORAS_SEMANA_POR_DEFECTO,
    })
    // Y al revés: un optometra al que se le pase a por_paciente pierde el tope.
    expect(normalizarEsquemaYTope({ type: 'optometra', payScheme: 'por_paciente', maxHoursPerWeek: 42 })).toEqual({
      payScheme: 'por_paciente',
      maxHoursPerWeek: null,
    })
  })

  it('respeta el tope declarado cuando es de salario', () => {
    expect(normalizarEsquemaYTope({ type: 'optometra', payScheme: 'fijo', maxHoursPerWeek: 42 }))
      .toEqual({ payScheme: 'fijo', maxHoursPerWeek: 42 })
  })

  it('un esquema invalido cae al defecto del tipo, no lo propaga', () => {
    expect(normalizarEsquemaYTope({ type: 'auxiliar', payScheme: 'inventado' }).payScheme).toBe('fijo')
    expect(normalizarEsquemaYTope({ type: 'oftalmologo', payScheme: 'inventado' }).payScheme).toBe('por_paciente')
  })

  it('sin argumentos no explota y devuelve algo coherente', () => {
    expect(normalizarEsquemaYTope()).toEqual({ payScheme: 'fijo', maxHoursPerWeek: HORAS_SEMANA_POR_DEFECTO })
  })
})

describe('reproduccion del bug de produccion', () => {
  it('la entrada que creo los 94 oftalmologos rotos ya no produce fijo + NULL', () => {
    // Fila de la carga en lote: oftalmologo con esquemaPago=fijo y sin horas.
    // Antes el codigo escribia tope NULL (por el tipo) y esquema 'fijo' (por el
    // CSV) — la combinacion que devolvia 0% de utilizacion.
    const r = normalizarEsquemaYTope({ type: 'oftalmologo', payScheme: 'fijo', maxHoursPerWeek: undefined })
    expect(r.payScheme).toBe('fijo')
    expect(r.maxHoursPerWeek).toBe(HORAS_SEMANA_POR_DEFECTO)
    expect(r.maxHoursPerWeek).not.toBeNull()
  })
})
