import { describe, it, expect } from 'vitest'
import {
  normalizarEsquemaYTope,
  HORAS_SEMANA_POR_DEFECTO,
  TIPOS_POR_PACIENTE,
  ESQUEMAS_PAGO,
  TIPOS_RECURSO,
  TIPOS_QUE_IMPACTAN_PACIENTES,
  tiposConAgendaPermitidos,
  TIPOS_MULTI_CONSULTORIO,
  puedeMultiConsultorio,
  requiereIntervaloPorPaciente,
  TIPOS_QUE_LIBERAN_AUXILIAR,
  TIPOS_SIN_COORDINADOR_LIDER,
  TIPOS_CON_SUBESPECIALIDAD,
  TIPO_RECURSO_LABEL,
  etiquetaTipoRecurso,
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
    // Oct-2026 · 'otorrino' salió de esta lista: pasó a por_paciente, igual que
    // el oftalmólogo, por decisión de Hector. Ya no tiene tope semanal.
    for (const type of ['auxiliar', 'tecnico', 'asesor_servicios', 'anestesiologo', 'optometra']) {
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

// ============================================================================
// PROYECTOS-3398 §8 — EL FILTRO DEL TABLERO INTERSECTA, NO AMPLIA
//
// El tablero de Reprogramaciones solo puede hablar de quien tiene agenda propia
// de pacientes. El parametro `?resource_type=` de la consulta sirve para afinar
// DENTRO de ese conjunto, y es el punto por donde la regla se podria evadir:
// basta editar la barra de direcciones.
//
// Estas pruebas no necesitan base de datos porque la regla es una funcion pura
// sobre dos listas — el mismo patron de normalizarEsquemaYTope. Si algun dia
// alguien "arregla" el filtro para que respete lo que pide el cliente, esto
// falla antes de llegar a produccion.
// ============================================================================
describe('tiposConAgendaPermitidos', () => {
  it('sin filtro devuelve exactamente los tipos con agenda de pacientes', () => {
    expect(new Set(tiposConAgendaPermitidos(null))).toEqual(TIPOS_QUE_IMPACTAN_PACIENTES)
    expect(new Set(tiposConAgendaPermitidos([]))).toEqual(TIPOS_QUE_IMPACTAN_PACIENTES)
  })

  it('un tipo con agenda si afina la consulta', () => {
    expect(tiposConAgendaPermitidos(['oftalmologo'])).toEqual(['oftalmologo'])
    expect(tiposConAgendaPermitidos(['oftalmologo', 'optometra'])).toEqual(['oftalmologo', 'optometra'])
  })

  it('pedir un auxiliar devuelve vacio, no se cuela', () => {
    expect(tiposConAgendaPermitidos(['auxiliar'])).toEqual([])
    expect(tiposConAgendaPermitidos(['asesor_servicios'])).toEqual([])
  })

  it('mezclar uno permitido con uno prohibido descarta solo el prohibido', () => {
    expect(tiposConAgendaPermitidos(['auxiliar', 'oftalmologo'])).toEqual(['oftalmologo'])
  })

  it('un tipo inventado no pasa', () => {
    expect(tiposConAgendaPermitidos(['medico_jefe_supremo'])).toEqual([])
  })

  it('NINGUN tipo de recurso existente puede entrar si no esta en la lista', () => {
    // La prueba que de verdad importa: se recorre el enum completo, asi que al
    // agregar un tipo nuevo a la BD hay que decidir a conciencia si tiene agenda
    // propia. Antes el riesgo era al contrario — el tipo nuevo entraba solo.
    for (const tipo of TIPOS_RECURSO) {
      const permitido = tiposConAgendaPermitidos([tipo])
      if (TIPOS_QUE_IMPACTAN_PACIENTES.has(tipo)) {
        expect(permitido).toEqual([tipo])
      } else {
        expect(permitido).toEqual([])
      }
    }
  })

  it('auxiliares y asesores quedan fuera de la lista de agenda propia', () => {
    // Son el caso concreto que inflaba el tablero: una auxiliar que falta no
    // deja una agenda que reprogramar, pero se contaba como si la dejara.
    expect(TIPOS_QUE_IMPACTAN_PACIENTES.has('auxiliar')).toBe(false)
    expect(TIPOS_QUE_IMPACTAN_PACIENTES.has('asesor_servicios')).toBe(false)
  })

  it('todos los tipos con agenda son tipos de recurso validos', () => {
    // Protege contra un typo en la lista: un 'oftalmologo ' con espacio no
    // casaria nunca y el tablero perderia a los oftalmologos en silencio.
    for (const tipo of TIPOS_QUE_IMPACTAN_PACIENTES) {
      expect(TIPOS_RECURSO).toContain(tipo)
    }
  })
})

// ============================================================================
// MULTI-CONSULTORIO E INTERVALO POR PACIENTE
//
// Estas dos reglas vivian escritas a mano en cinco sitios — tres del backend y
// dos del frontend — y por eso 'otorrino' quedo fuera de las dos aunque opera
// igual que el oftalmologo. Las pruebas recorren el ENUM COMPLETO de tipos, asi
// que al agregar un tipo nuevo a la base hay que decidir a conciencia si rota
// entre salas y si tiene agenda propia. Antes el tipo nuevo quedaba fuera solo,
// y en silencio.
// ============================================================================
describe('puedeMultiConsultorio', () => {
  it('oftalmologo y otorrino si pueden', () => {
    expect(puedeMultiConsultorio('oftalmologo')).toBe(true)
    expect(puedeMultiConsultorio('otorrino')).toBe(true)
  })

  it('quien no rota entre salas no puede', () => {
    for (const tipo of ['auxiliar', 'asesor_servicios', 'tecnico', 'optometra', 'anestesiologo', 'fonoaudiologa']) {
      expect(puedeMultiConsultorio(tipo)).toBe(false)
    }
  })

  it('un tipo inventado no puede', () => {
    expect(puedeMultiConsultorio('medico_volador')).toBe(false)
    expect(puedeMultiConsultorio(undefined)).toBe(false)
  })

  it('recorre el enum completo: ningun tipo queda sin decision explicita', () => {
    for (const tipo of TIPOS_RECURSO) {
      expect(puedeMultiConsultorio(tipo)).toBe(TIPOS_MULTI_CONSULTORIO.has(tipo))
    }
  })

  it('todos los que pueden multi-consultorio son tipos de recurso validos', () => {
    // Protege contra un typo: un 'otorrino ' con espacio no casaria nunca y la
    // casilla no se mostraria, que es exactamente el sintoma que tuvimos.
    for (const tipo of TIPOS_MULTI_CONSULTORIO) {
      expect(TIPOS_RECURSO).toContain(tipo)
    }
  })

  it('quien cubre varias salas tiene agenda propia de pacientes', () => {
    // No es casualidad: la union de intervalos solo tiene sentido para quien
    // rota atendiendo SU agenda en varias salas a la vez.
    for (const tipo of TIPOS_MULTI_CONSULTORIO) {
      expect(TIPOS_QUE_IMPACTAN_PACIENTES.has(tipo)).toBe(true)
    }
  })
})

describe('requiereIntervaloPorPaciente', () => {
  it('coincide con tener agenda propia de pacientes', () => {
    for (const tipo of TIPOS_RECURSO) {
      expect(requiereIntervaloPorPaciente(tipo)).toBe(TIPOS_QUE_IMPACTAN_PACIENTES.has(tipo))
    }
  })

  it('otorrino lo requiere — era el que faltaba', () => {
    expect(requiereIntervaloPorPaciente('otorrino')).toBe(true)
  })

  it('auxiliares y asesores no lo requieren', () => {
    expect(requiereIntervaloPorPaciente('auxiliar')).toBe(false)
    expect(requiereIntervaloPorPaciente('asesor_servicios')).toBe(false)
  })
})

describe('otorrino se comporta igual que oftalmologo', () => {
  // La peticion fue literal: "el otorrino debe ser igual al oftalmologo".
  // Esta prueba lo fija para que un cambio futuro en una sola de las listas
  // falle acá en vez de salir a produccion desalineado.
  it('comparte las reglas que dependen del tipo', () => {
    expect(puedeMultiConsultorio('otorrino')).toBe(puedeMultiConsultorio('oftalmologo'))
    expect(requiereIntervaloPorPaciente('otorrino')).toBe(requiereIntervaloPorPaciente('oftalmologo'))
    expect(TIPOS_QUE_IMPACTAN_PACIENTES.has('otorrino')).toBe(TIPOS_QUE_IMPACTAN_PACIENTES.has('oftalmologo'))
  })

  it('el esquema de pago TAMBIEN se iguala: sin tope semanal', () => {
    // Oct-2026 · Decision de Hector, explicita: "el otorrino tampoco tiene tope
    // semanal, debe ser IGUAL al de oftalmologia". Antes esta prueba fijaba lo
    // contrario a la espera de que direccion lo definiera; ya esta definido.
    expect(TIPOS_POR_PACIENTE.has('otorrino')).toBe(true)
    expect(TIPOS_POR_PACIENTE.has('otorrino')).toBe(TIPOS_POR_PACIENTE.has('oftalmologo'))
    expect(normalizarEsquemaYTope({ type: 'otorrino' }))
      .toEqual({ payScheme: 'por_paciente', maxHoursPerWeek: null })
  })
})

// ============================================================================
// "EL OTORRINO DEBE SER IGUAL AL OFTALMOLOGO" — la prueba que lo sostiene
//
// Decision de Hector, 6-oct-2026. En vez de confiar en que alguien se acuerde,
// esta prueba recorre TODAS las reglas del sistema que dependen del tipo de
// recurso y exige que los dos tengan la misma respuesta en cada una.
//
// Si manana se agrega una regla nueva por tipo y se deja al otorrino fuera, esto
// falla. Es la unica forma de que "igual" signifique igual y no "igual en lo que
// nos acordamos de revisar": esta diferencia se escapo TRES veces (jul-2026 no
// se podia crear, sep-2026 no pedia auxiliar, oct-2026 multi-consultorio,
// intervalo, tope semanal, RN-24, coordinador lider y subespecialidad).
//
// Las reglas que dependen de ESPECIALIDAD y no de tipo (apoyo obligatorio en
// consultorio) viven en lib/timeSlots.js y ya tenian a otorrinolaringologia.
// ============================================================================
describe('otorrino es igual al oftalmologo en TODAS las reglas por tipo', () => {
  const REGLAS = [
    ['tiene agenda propia de pacientes', TIPOS_QUE_IMPACTAN_PACIENTES],
    ['cobra por paciente (sin tope semanal)', TIPOS_POR_PACIENTE],
    ['puede cubrir varias salas en paralelo', TIPOS_MULTI_CONSULTORIO],
    ['libera a su auxiliar al faltar (RN-24)', TIPOS_QUE_LIBERAN_AUXILIAR],
    ['rota entre sedes, sin coordinador lider', TIPOS_SIN_COORDINADOR_LIDER],
    ['tiene subespecialidad', TIPOS_CON_SUBESPECIALIDAD],
  ]

  for (const [nombre, conjunto] of REGLAS) {
    it(nombre, () => {
      expect(conjunto.has('otorrino')).toBe(conjunto.has('oftalmologo'))
    })
  }

  it('las dos reglas derivadas tambien coinciden', () => {
    expect(puedeMultiConsultorio('otorrino')).toBe(puedeMultiConsultorio('oftalmologo'))
    expect(requiereIntervaloPorPaciente('otorrino')).toBe(requiereIntervaloPorPaciente('oftalmologo'))
    expect(normalizarEsquemaYTope({ type: 'otorrino' }))
      .toEqual(normalizarEsquemaYTope({ type: 'oftalmologo' }))
  })

  it('los dos tienen etiqueta legible, no el codigo en crudo', () => {
    // El mapa de authController.js no tenia 'otorrino', asi que el correo al
    // supervisor mostraba "otorrino" tal cual.
    for (const t of ['otorrino', 'oftalmologo']) {
      expect(TIPO_RECURSO_LABEL[t]).toBeTruthy()
      expect(etiquetaTipoRecurso(t)).not.toBe(t)
    }
  })

  it('TODOS los tipos del enum tienen etiqueta', () => {
    // Antes faltaban 'otorrino' y 'fonoaudiologa', y la clave de auxiliar estaba
    // escrita como 'assistant' — fuga del renombrado a ingles.
    for (const t of TIPOS_RECURSO) {
      expect(TIPO_RECURSO_LABEL[t], `falta la etiqueta de ${t}`).toBeTruthy()
    }
  })
})
