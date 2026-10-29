import { describe, it, expect } from 'vitest'
import {
  normalizar, motivoDe, MOTIVOS_NUEVOS, tipoLegadoDe, sedeDe, tipoDeEspecialidad, subespecialidadDe,
  emparejar, claveDeFila, diasEntre, fechaDeCelda, numeroDeCelda, siNo, nombrePropio, ALIAS, PROFESIONALES_NUEVOS,
} from './historicoReprogramaciones.js'

describe('normalizar', () => {
  it('quita tildes, espacios de más y pasa a mayúsculas', () => {
    expect(normalizar('  Miércoles  de  ceniza ')).toBe('MIERCOLES DE CENIZA')
    expect(normalizar('   ')).toBeNull()
    expect(normalizar(null)).toBeNull()
  })
})

describe('motivoDe', () => {
  it('los tipos más frecuentes del Excel', () => {
    expect(motivoDe('FORMATO')).toBe('hist_formato')
    expect(motivoDe('CAMBIO HORARIO')).toBe('hist_cambio_horario')
    expect(motivoDe('PERSONAL')).toBe('hist_personal')
    expect(motivoDe('DISMINUIR PACIENTES')).toBe('hist_disminuir_pacientes')
    expect(motivoDe('DIA FESTIVO')).toBe('hist_festivo')
  })
  it('reutiliza los motivos del sistema cuando son lo mismo', () => {
    expect(motivoDe('MEDICA')).toBe('enfermedad')
    expect(motivoDe('AUSENCIA MEDICA')).toBe('enfermedad')
    expect(motivoDe('CONGRESO')).toBe('academico')
    expect(motivoDe('VACACIONES FELLOW')).toBe('vacaciones')
  })
  it('agrupa las variantes mal escritas', () => {
    expect(motivoDe('DISMIUIR PACIENTES')).toBe('hist_disminuir_pacientes')
    expect(motivoDe('MANTEMINIENTO')).toBe('hist_mantenimiento')
    expect(motivoDe('MODIFICION AGENDA')).toBe('hist_movimiento_agenda')
    expect(motivoDe('cambia sede ')).toBe('hist_cambio_sede')
  })
  it('todas las regionales y los "cubre <ciudad>" son movilidad', () => {
    for (const t of ['REGIONAL VALLEDUPAR', 'REGIONAL CARTAGENA ', 'REGINAL SANTA MARTA', 'REGIONAL', 'CUBRE SABANALARGA', 'CUBRE SANABALARGA'])
      expect(motivoDe(t)).toBe('hist_regional')
  })
  it('CUBRE QX es cirugía, no regional', () => {
    expect(motivoDe('CUBRE QX')).toBe('hist_cirugia')
  })
  it('sin tipo o desconocido → Otro (histórico)', () => {
    expect(motivoDe(null)).toBe('hist_otro')
    expect(motivoDe('ALGO NUEVO')).toBe('hist_otro')
  })
  it('todo código que devuelve existe en el sistema o en MOTIVOS_NUEVOS', () => {
    const nuevos = new Set(MOTIVOS_NUEVOS.map((m) => m.code))
    const sistema = new Set(['enfermedad', 'academico', 'vacaciones'])
    for (const t of ['FORMATO', 'LICENCIA', 'FIN CONTRATO', 'JUNTA MEDICA', 'CIRUGIA', 'BRIGADA', 'TERCER NIVEL', 'LLENAR AGENDA', 'AUSENCIA', 'SEDE EXTERNA', 'PROGRAMACION MALL'])
      expect(nuevos.has(motivoDe(t)) || sistema.has(motivoDe(t))).toBe(true)
  })
})

describe('tipoLegadoDe', () => {
  it('usa el enum viejo si existe; si no, otra', () => {
    expect(tipoLegadoDe('vacaciones')).toBe('vacaciones')
    expect(tipoLegadoDe('hist_formato')).toBe('otra')
  })
})

describe('sedeDe', () => {
  it('las cuatro sedes del Excel', () => {
    expect(sedeDe('DOS', 'oftalmologo')).toBe('Sede 2')
    expect(sedeDe('VIVA ', 'oftalmologo')).toBe('Sede Viva')
    expect(sedeDe('ALEGRA', 'oftalmologo')).toBe('Sede Alegra')
    expect(sedeDe('SALA AZUL VIVA', 'oftalmologo')).toBe('Sede Viva')
  })
  it('Alkarawi depende del profesional', () => {
    expect(sedeDe('ALKARAWI', 'oftalmologo')).toBe('Sede 3 Alkarawi')
    expect(sedeDe('ALKARAWI ', 'otorrino')).toBe('Sede Alkarawi Otorrino')
    expect(sedeDe('ALKARAWI', 'fonoaudiologa')).toBe('Sede Alkarawi Otorrino')
  })
  it('lo que no se sabe queda sin sede', () => {
    expect(sedeDe('SEDE 1', 'oftalmologo')).toBeNull()
    expect(sedeDe(null, 'oftalmologo')).toBeNull()
  })
})

describe('tipo y subespecialidad', () => {
  it('especialidad del Excel → tipo de profesional', () => {
    expect(tipoDeEspecialidad('OFTAMLOLOGIA')).toBe('oftalmologo')
    expect(tipoDeEspecialidad('AUDIOLOGIA')).toBe('fonoaudiologa')
    expect(tipoDeEspecialidad('OTORRINO')).toBe('otorrino')
    expect(tipoDeEspecialidad('AYUDA DIAGNOSTICA')).toBeNull()
  })
  it('subespecialidad del Excel → catálogo', () => {
    expect(subespecialidadDe('oftalmologo', 'GENERAL ')).toBe('Oftalmología general')
    expect(subespecialidadDe('otorrino', 'GENERAL')).toBe('Otorrinolaringología general')
    expect(subespecialidadDe('oftalmologo', 'PEDIATRICA')).toBe('Oftalmopediatría')
    expect(subespecialidadDe('oftalmologo', 'SEGMENTO')).toBe('Segmento anterior')
    expect(subespecialidadDe('otorrino', 'NASOFARINGOLARINGOSCOPIA')).toBeNull()   // procedimiento
    expect(subespecialidadDe('optometra', 'ORTOPTICA')).toBeNull()                 // sin catálogo
  })
})

describe('emparejar', () => {
  const R = [
    { id: '1', name: 'Patricia Isabel Pombo Cogollo', type: 'oftalmologo' },
    { id: '2', name: 'Gina Maria Casale Areyanes', type: 'fonoaudiologa' },
    { id: '3', name: 'Pablo Chamartin Escobar', type: 'oftalmologo' },
    { id: '4', name: 'Pablo Chamartin', type: 'oftalmologo' },
    { id: '5', name: 'Gloria Acosta-Otorrino', type: 'otorrino' },
    { id: '6', name: 'Gloria Isabel Acosta Casas', type: 'oftalmologo' },
  ]
  it('nombre corto contra nombre completo', () => {
    expect(emparejar('PATRICIA POMBO', 'oftalmologo', R).recurso.id).toBe('1')
  })
  it('error de escritura resuelto por alias', () => {
    expect(emparejar('GINA CASALES', 'fonoaudiologa', R).recurso.id).toBe('2')
  })
  it('duplicado del catálogo resuelto por alias', () => {
    expect(emparejar('PABLO CHAMARTIN', 'oftalmologo', R).recurso.id).toBe('3')
  })
  it('entre dos candidatos gana el del tipo del Excel', () => {
    expect(emparejar('GLORIA ACOSTA', 'otorrino', R).recurso.id).toBe('5')
  })
  it('sin candidato', () => {
    expect(emparejar('NADIE CONOCIDO', 'oftalmologo', R).error).toBe('no está en el SGRC')
  })
  it('alias y nuevos no se pisan', () => {
    for (const k of Object.keys(PROFESIONALES_NUEVOS)) expect(ALIAS[k]).toBeUndefined()
  })
})

describe('claveDeFila', () => {
  const fila = { medico: 'JENIFER MONTERROZA', agenda: 'JENIFER MONTERROZA PAC PA', fecha: '2026-01-05', tipo: 'REGIONAL SANTA MARTA', reportada: '2025-12-10' }
  it('la copia pegada en otra hoja da la misma clave aunque cambien espacios o tildes', () => {
    expect(claveDeFila({ ...fila, agenda: ' jenifer  monterroza pac pa ' })).toBe(claveDeFila(fila))
  })
  it('otra agenda del mismo día es otra fila', () => {
    expect(claveDeFila({ ...fila, agenda: 'JENIFER MONTERROZA EVENTO' })).not.toBe(claveDeFila(fila))
  })
  it('cabe en la columna (64)', () => {
    expect(claveDeFila(fila).length).toBeLessThanOrEqual(64)
  })
})

describe('celdas', () => {
  it('fechas', () => {
    expect(fechaDeCelda(new Date('2026-01-05T00:00:00Z'))).toBe('2026-01-05')
    expect(fechaDeCelda('2026-02-03 00:00:00')).toBe('2026-02-03')
    expect(fechaDeCelda('5/1/2026')).toBe('2026-01-05')
    expect(fechaDeCelda('mañana')).toBeNull()
  })
  it('números, sí/no y nombres', () => {
    expect(numeroDeCelda(5.0)).toBe(5)
    expect(numeroDeCelda('12')).toBe(12)
    expect(numeroDeCelda('')).toBeNull()
    expect(siNo('Sí')).toBe(true)
    expect(siNo('NO ')).toBe(false)
    expect(siNo(null)).toBeNull()
    expect(nombrePropio('CRISTIAN VIAÑA ')).toBe('Cristian Viaña')
    expect(diasEntre('2025-12-10', '2026-01-05')).toBe(26)
  })
})
