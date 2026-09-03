import { describe, it, expect } from 'vitest'
import { programacionLibre, avisoProgramacionLibre } from './schedulingMode.js'

describe('programacionLibre', () => {
  it('está APAGADO si la variable no existe — el defecto es el comportamiento normal', () => {
    expect(programacionLibre({})).toBe(false)
  })

  it('se enciende solo con el valor exacto true', () => {
    expect(programacionLibre({ PROGRAMACION_LIBRE: 'true' })).toBe(true)
    expect(programacionLibre({ PROGRAMACION_LIBRE: 'TRUE' })).toBe(true)
  })

  it('cualquier otro valor lo deja apagado (fallo seguro)', () => {
    for (const v of ['false', '1', 'si', 'yes', '', 'activo']) {
      expect(programacionLibre({ PROGRAMACION_LIBRE: v }), `valor: ${v}`).toBe(false)
    }
  })
})

describe('avisoProgramacionLibre', () => {
  it('no dice nada si el modo está apagado', () => {
    expect(avisoProgramacionLibre({})).toBeNull()
  })

  it('avisa y explica cómo revertirlo cuando está encendido', () => {
    const aviso = avisoProgramacionLibre({ PROGRAMACION_LIBRE: 'true' })
    expect(aviso).toContain('PROGRAMACIÓN LIBRE ACTIVADA')
    expect(aviso).toContain('auto-cierre nocturno está en pausa')
    expect(aviso).toContain('SIGUEN validándose')   // que no se malinterprete el alcance
    expect(aviso).toContain('reiniciar')
  })
})
