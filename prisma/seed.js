/**
 * Seed completo del SGRC — datos realistas y variados para que TODAS las
 * pantallas del frontend se vean con vida.
 *
 * Idempotente:
 *  - Entidades con clave natural (email, nombre + sede) usan upsert.
 *  - Asignaciones/ejecuciones/ausencias se crean solo si la BD está "limpia"
 *    (sin asignaciones aún) — para evitar duplicar al re-correr.
 *
 * Para resetear todo: `npm run db:reset` (borra y vuelve a sembrar).
 */
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcrypt'
import { startOfWeek, addDays, subWeeks, format } from 'date-fns'

const prisma = new PrismaClient()

// ============ CONFIG ============
const PASS = 'Admin123'
const RECARGO_NOCTURNO_FROM = '18:00'

const aHora = (h, m = 0) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`

const capacidad = (hi, hf, intervaloMin) => {
  const [h1, m1] = hi.split(':').map(Number)
  const [h2, m2] = hf.split(':').map(Number)
  const min = (h2 * 60 + m2) - (h1 * 60 + m1)
  const almuerzo = min >= 360 ? 60 : 0
  return Math.floor((min - almuerzo) / (intervaloMin || 15))
}

const tieneNocturna = (hi, hf) => hf > RECARGO_NOCTURNO_FROM || hi >= RECARGO_NOCTURNO_FROM

const DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo']
const pick = (arr, i) => arr[i % arr.length]

// ============ MAIN ============
async function main() {
  console.log('🌱 Sembrando datos realistas...')

  // ============ 1. SEDES (upsert por nombre) ============
  const sedesData = [
    { nombre: 'Sede 1 Barranquilla', ciudad: 'Barranquilla', direccion: 'Cl. 76 #50-10' },
    { nombre: 'Sede 2 Barranquilla', ciudad: 'Barranquilla', direccion: 'Cra. 53 #80-32' },
    { nombre: 'Sede Santa Marta',    ciudad: 'Santa Marta',  direccion: 'Cl. 22 #4-30' },
    { nombre: 'Sede Cartagena',      ciudad: 'Cartagena',    direccion: 'Av. San Martín' },
    { nombre: 'Sede Valledupar',     ciudad: 'Valledupar',   direccion: 'Cra. 19 #16-50' },
    { nombre: 'Sede Riohacha',       ciudad: 'Riohacha',     direccion: 'Cl. 15 #7-20' },
    { nombre: 'Sede Sabanalarga',    ciudad: 'Sabanalarga',  direccion: 'Cl. 20 #19-15' },
  ]
  const sedes = []
  for (const s of sedesData) {
    const existente = await prisma.sede.findFirst({ where: { nombre: s.nombre } })
    const sede = existente
      ? await prisma.sede.update({ where: { id: existente.id }, data: s })
      : await prisma.sede.create({ data: s })
    sedes.push(sede)
  }
  console.log(`   ✓ ${sedes.length} sedes`)

  // Helper para indexar por nombre
  const sedeBQ1 = sedes.find((s) => s.nombre === 'Sede 1 Barranquilla')
  const sedeBQ2 = sedes.find((s) => s.nombre === 'Sede 2 Barranquilla')
  const sedeSM  = sedes.find((s) => s.nombre === 'Sede Santa Marta')
  const sedeCTG = sedes.find((s) => s.nombre === 'Sede Cartagena')
  const sedeVPA = sedes.find((s) => s.nombre === 'Sede Valledupar')
  const sedeRCH = sedes.find((s) => s.nombre === 'Sede Riohacha')
  const sedeSNL = sedes.find((s) => s.nombre === 'Sede Sabanalarga')

  // ============ 2. CONSULTORIOS — en TODAS las sedes ============
  const consultoriosData = [
    // BQ1
    { sede: sedeBQ1, nombre: 'Cons. 1', especialidad: 'oftalmologia' },
    { sede: sedeBQ1, nombre: 'Cons. 2', especialidad: 'oftalmologia' },
    { sede: sedeBQ1, nombre: 'Cons. 3', especialidad: 'optometria' },
    { sede: sedeBQ1, nombre: 'Cons. 4', especialidad: 'optometria' },
    { sede: sedeBQ1, nombre: 'Cons. 5', especialidad: 'diagnostico' },
    // BQ2 (los que ya teníamos)
    { sede: sedeBQ2, nombre: 'Cons. 6',  especialidad: 'oftalmologia' },
    { sede: sedeBQ2, nombre: 'Cons. 9',  especialidad: 'oftalmologia' },
    { sede: sedeBQ2, nombre: 'Cons. 13', especialidad: 'optometria' },
    { sede: sedeBQ2, nombre: 'Cons. 14', especialidad: 'optometria' },
    { sede: sedeBQ2, nombre: 'Cons. 1 Ec', especialidad: 'diagnostico' },
    { sede: sedeBQ2, nombre: 'Cons. 2 An', especialidad: 'anestesiologia' },
    // Santa Marta
    { sede: sedeSM, nombre: 'SM-Cons. 1', especialidad: 'oftalmologia' },
    { sede: sedeSM, nombre: 'SM-Cons. 2', especialidad: 'optometria' },
    { sede: sedeSM, nombre: 'SM-Cons. 3', especialidad: 'diagnostico' },
    // Cartagena
    { sede: sedeCTG, nombre: 'CTG-Cons. 1', especialidad: 'oftalmologia' },
    { sede: sedeCTG, nombre: 'CTG-Cons. 2', especialidad: 'optometria' },
    // Valledupar
    { sede: sedeVPA, nombre: 'VPA-Cons. 1', especialidad: 'oftalmologia' },
    { sede: sedeVPA, nombre: 'VPA-Cons. 2', especialidad: 'optometria' },
    // Riohacha
    { sede: sedeRCH, nombre: 'RCH-Cons. 1', especialidad: 'oftalmologia' },
    { sede: sedeRCH, nombre: 'RCH-Cons. 2', especialidad: 'optometria' },
    // Sabanalarga
    { sede: sedeSNL, nombre: 'SNL-Cons. 1', especialidad: 'oftalmologia' },
    { sede: sedeSNL, nombre: 'SNL-Cons. 2', especialidad: 'optometria' },
  ]
  const REQUIEREN_AUX = new Set(['oftalmologia', 'anestesiologia'])
  const consultorios = []
  for (const c of consultoriosData) {
    const existente = await prisma.consultorio.findFirst({
      where: { nombre: c.nombre, sedeId: c.sede.id },
    })
    const data = {
      sedeId: c.sede.id,
      nombre: c.nombre,
      especialidad: c.especialidad,
      requiereAuxiliar: REQUIEREN_AUX.has(c.especialidad),
    }
    const cons = existente
      ? await prisma.consultorio.update({ where: { id: existente.id }, data })
      : await prisma.consultorio.create({ data })
    consultorios.push({ ...cons, sede: c.sede })
  }
  console.log(`   ✓ ${consultorios.length} consultorios en ${sedes.length} sedes`)

  // ============ 3. RECURSOS — variedad realista ============
  const recursosData = [
    // Oftalmólogos
    { nombre: 'Dr. Rhenals',  tipo: 'oftalmologo',   especialidad: 'Retina',         intervaloMinutos: 20, esquemaPago: 'por_paciente', horasMaxSemana: 60, horasMaxDia: 12 },
    { nombre: 'Dr. Martínez', tipo: 'oftalmologo',   especialidad: 'Retina',         intervaloMinutos: 20, esquemaPago: 'por_paciente', horasMaxSemana: 60, horasMaxDia: 12 },
    { nombre: 'Dr. Córnea',   tipo: 'oftalmologo',   especialidad: 'Córnea',         intervaloMinutos: 20, esquemaPago: 'por_paciente', horasMaxSemana: 60, horasMaxDia: 12 },
    { nombre: 'Dr. Sanabria', tipo: 'oftalmologo',   especialidad: 'Glaucoma',       intervaloMinutos: 25, esquemaPago: 'por_paciente', horasMaxSemana: 60, horasMaxDia: 12 },
    { nombre: 'Dra. Polo',    tipo: 'oftalmologo',   especialidad: 'Cataratas',      intervaloMinutos: 30, esquemaPago: 'por_paciente', horasMaxSemana: 60, horasMaxDia: 12 },
    // Optómetras
    { nombre: 'Dr. Gutierrez', tipo: 'optometra', especialidad: 'General', intervaloMinutos: 15, esquemaPago: 'mixto' },
    { nombre: 'Dr. Escudero',  tipo: 'optometra', especialidad: 'General', intervaloMinutos: 15, esquemaPago: 'mixto' },
    { nombre: 'Dra. Meza',     tipo: 'optometra', especialidad: 'Lentes de contacto', intervaloMinutos: 20, esquemaPago: 'mixto' },
    { nombre: 'Dr. Pacheco',   tipo: 'optometra', especialidad: 'Pediátrica', intervaloMinutos: 20, esquemaPago: 'mixto' },
    // Anestesiólogo
    { nombre: 'Dr. Pérez Anest.',  tipo: 'anestesiologo', especialidad: 'Anestesia', intervaloMinutos: 30, esquemaPago: 'por_paciente', horasMaxSemana: 60, horasMaxDia: 12 },
    // Auxiliares
    { nombre: 'Angela Sarmiento',     tipo: 'auxiliar', esquemaPago: 'fijo' },
    { nombre: 'Alba Tete',            tipo: 'auxiliar', esquemaPago: 'fijo' },
    { nombre: 'Ana Castillo',         tipo: 'auxiliar', esquemaPago: 'fijo' },
    { nombre: 'Ana Nuñez',            tipo: 'auxiliar', esquemaPago: 'fijo' },
    { nombre: 'Cynthia Maury',        tipo: 'auxiliar', esquemaPago: 'fijo' },
    { nombre: 'Darleis Silva',        tipo: 'auxiliar', esquemaPago: 'fijo' },
    { nombre: 'Yasiris Trespalacios', tipo: 'auxiliar', esquemaPago: 'fijo' },
    { nombre: 'Doraine Barrios',      tipo: 'auxiliar', esquemaPago: 'fijo' },
    { nombre: 'Lina Torres',          tipo: 'auxiliar', esquemaPago: 'fijo' },
    { nombre: 'Yurley Pua',           tipo: 'auxiliar', esquemaPago: 'fijo' },
    // Técnicos
    { nombre: 'Tec. Rivera',  tipo: 'tecnico', intervaloMinutos: 30, esquemaPago: 'fijo' },
    { nombre: 'Tec. Mendez',  tipo: 'tecnico', intervaloMinutos: 30, esquemaPago: 'fijo' },
    { nombre: 'Tec. Carlos Díaz', tipo: 'tecnico', intervaloMinutos: 30, esquemaPago: 'fijo' },
  ]
  const recursos = []
  for (const r of recursosData) {
    const existente = await prisma.recurso.findFirst({ where: { nombre: r.nombre } })
    const rec = existente
      ? await prisma.recurso.update({ where: { id: existente.id }, data: r })
      : await prisma.recurso.create({ data: r })
    recursos.push(rec)
  }
  console.log(`   ✓ ${recursos.length} recursos`)

  const oftalmologos = recursos.filter((r) => r.tipo === 'oftalmologo')
  const optometras   = recursos.filter((r) => r.tipo === 'optometra')
  const auxiliares   = recursos.filter((r) => r.tipo === 'auxiliar')
  const tecnicos     = recursos.filter((r) => r.tipo === 'tecnico')
  const anestesiologo = recursos.find((r) => r.tipo === 'anestesiologo')

  // ============ 4. USUARIOS (upsert por email) ============
  const pwHash = await bcrypt.hash(PASS, 12)
  const usuarios = [
    {
      email: 'angela.sarmiento@cofca.co', nombre: 'Angela Sarmiento', rol: 'recurso',
      recursoId: recursos.find((r) => r.nombre === 'Angela Sarmiento').id, celular: '300 555 0001',
    },
    {
      email: 'maria.lopez@cofca.co', nombre: 'María López', rol: 'coordinador',
      celular: '300 555 0002', sedes: [sedeBQ2.id, sedeBQ1.id],
    },
    {
      email: 'pedro.rodriguez@cofca.co', nombre: 'Pedro Rodríguez', rol: 'coordinador',
      celular: '300 555 0003', sedes: [sedeSM.id, sedeCTG.id],
    },
    {
      email: 'carlos.reyes@cofca.co', nombre: 'Carlos Reyes', rol: 'directivo',
    },
    {
      email: 'desarrollo@cofca.com', nombre: 'Diana Martínez', rol: 'supervisor',
    },
  ]
  const usuariosCreados = {}
  for (const u of usuarios) {
    const sedesRel = u.sedes ?? []
    const existente = await prisma.usuario.findUnique({ where: { email: u.email } })
    let usuario
    if (existente) {
      usuario = await prisma.usuario.update({
        where: { id: existente.id },
        data: {
          nombre: u.nombre,
          celular: u.celular,
          passwordHash: pwHash,
          rol: u.rol,
          recursoId: u.recursoId,
        },
      })
      // Resetear sedes (idempotente)
      await prisma.usuarioSede.deleteMany({ where: { usuarioId: usuario.id } })
    } else {
      usuario = await prisma.usuario.create({
        data: {
          email: u.email,
          nombre: u.nombre,
          celular: u.celular,
          passwordHash: pwHash,
          rol: u.rol,
          recursoId: u.recursoId,
        },
      })
    }
    if (sedesRel.length > 0) {
      await prisma.usuarioSede.createMany({
        data: sedesRel.map((sedeId) => ({ usuarioId: usuario.id, sedeId })),
      })
    }
    usuariosCreados[u.rol] = usuario
  }
  const coordinador = usuariosCreados.coordinador // María
  console.log(`   ✓ ${usuarios.length} usuarios (password: ${PASS})`)

  // ============ 5. PARÁMETROS DE COSTO (upsert por tipo + vigencia) ============
  const parametrosCosto = [
    { tipoConsulta: 'oftalmologia',   costoCita: 150000, costoReprogramacion: 8000 },
    { tipoConsulta: 'optometria',     costoCita: 50000,  costoReprogramacion: 5000 },
    { tipoConsulta: 'anestesiologia', costoCita: 250000, costoReprogramacion: 12000 },
    { tipoConsulta: 'diagnostico',    costoCita: 80000,  costoReprogramacion: 6000 },
  ]
  const vigDate = new Date('2026-01-01')
  for (const p of parametrosCosto) {
    const exists = await prisma.parametroCosto.findFirst({
      where: { tipoConsulta: p.tipoConsulta, vigenteDesde: vigDate },
    })
    if (!exists) {
      await prisma.parametroCosto.create({
        data: { ...p, vigenteDesde: vigDate, configuradoPor: coordinador.id },
      })
    }
  }
  console.log(`   ✓ ${parametrosCosto.length} parámetros de costo`)

  // ============ 6. PARÁMETROS DEL SISTEMA ============
  const parametrosSistema = [
    { clave: 'meta_ocupacion_consultorios', valor: 80 },
    { clave: 'meta_utilizacion_th',         valor: 90 },
    { clave: 'meta_cumplimiento_ejecucion', valor: 85 },
    { clave: 'semaforo_umbral_naranja',     valor: 10 },
    { clave: 'base_horas_lun_vie_min',      valor: 720 },
    { clave: 'base_horas_sabado_min',       valor: 240 },
  ]
  for (const p of parametrosSistema) {
    await prisma.parametroSistema.upsert({
      where: { clave: p.clave },
      update: { valor: p.valor, updatedBy: usuariosCreados.supervisor.id },
      create: { clave: p.clave, valor: p.valor, updatedBy: usuariosCreados.supervisor.id },
    })
  }
  console.log(`   ✓ ${parametrosSistema.length} parámetros del sistema`)

  // ============ 7. TAREAS BACKOFFICE (upsert por nombre) ============
  const tareasBackoffice = [
    { nombre: 'Confirmación de citas', tiempoEstimadoMinutos: 5 },
    { nombre: 'Generación de autorizaciones', tiempoEstimadoMinutos: 10 },
    { nombre: 'Llamadas de seguimiento postoperatorio', tiempoEstimadoMinutos: 8 },
    { nombre: 'Archivo y digitalización', tiempoEstimadoMinutos: 3 },
    { nombre: 'Verificación de historias clínicas', tiempoEstimadoMinutos: 6 },
    { nombre: 'Cubrir almuerzos',      descripcion: 'Cubrimiento del horario de almuerzo de otros recursos asistenciales.',         tiempoEstimadoMinutos: 60 },
    { nombre: 'Visitas hospitalarias', descripcion: 'Visitas a pacientes hospitalizados.',                                           tiempoEstimadoMinutos: 90 },
    { nombre: 'Citas personalizadas',  descripcion: 'Atención de citas personalizadas/agendadas fuera de la consulta regular.',     tiempoEstimadoMinutos: 30 },
    { nombre: 'Brigadas',              descripcion: 'Apoyo en brigadas de salud (intramurales o extramurales).',                     tiempoEstimadoMinutos: 240 },
    { nombre: 'Apoyo SIAU',            descripcion: 'Apoyo al Servicio de Información y Atención al Usuario (SIAU).',                tiempoEstimadoMinutos: 60 },
    { nombre: 'Apoyo Cirugía',         descripcion: 'Apoyo al servicio de cirugía (preparación, instrumentación, postoperatorio).', tiempoEstimadoMinutos: 120 },
  ]
  const tareasBoCreadas = []
  for (const t of tareasBackoffice) {
    const exists = await prisma.tareaBackoffice.findFirst({ where: { nombre: t.nombre } })
    const tarea = exists
      ? await prisma.tareaBackoffice.update({ where: { id: exists.id }, data: t })
      : await prisma.tareaBackoffice.create({
          data: { ...t, creadaPor: usuariosCreados.supervisor.id },
        })
    tareasBoCreadas.push(tarea)
  }
  console.log(`   ✓ ${tareasBoCreadas.length} tareas de backoffice`)

  // ============ 8. FESTIVOS ============
  const festivos = [
    { fecha: new Date('2026-01-01'), descripcion: 'Año Nuevo' },
    { fecha: new Date('2026-01-12'), descripcion: 'Día de los Reyes Magos' },
    { fecha: new Date('2026-03-23'), descripcion: 'Día de San José' },
    { fecha: new Date('2026-04-02'), descripcion: 'Jueves Santo' },
    { fecha: new Date('2026-04-03'), descripcion: 'Viernes Santo' },
    { fecha: new Date('2026-05-01'), descripcion: 'Día del Trabajo' },
    { fecha: new Date('2026-07-20'), descripcion: 'Día de la Independencia' },
    { fecha: new Date('2026-08-07'), descripcion: 'Batalla de Boyacá' },
    { fecha: new Date('2026-12-08'), descripcion: 'Inmaculada Concepción' },
    { fecha: new Date('2026-12-25'), descripcion: 'Navidad' },
  ]
  for (const f of festivos) {
    await prisma.festivo.upsert({
      where: { fecha: f.fecha },
      update: { descripcion: f.descripcion },
      create: f,
    })
  }
  console.log(`   ✓ ${festivos.length} festivos`)

  // ============ 9. SEMANAS Y ASIGNACIONES — solo si la BD está vacía de asignaciones ============
  const yaHayAsigs = await prisma.asignacion.count()
  if (yaHayAsigs > 0) {
    console.log(`   ⊙ ${yaHayAsigs} asignaciones ya en BD — skip de semanas/asignaciones/ejecuciones/ausencias`)
  } else {
    // 4 semanas: 2 anteriores cerradas, semana actual abierta, próxima semana abierta.
    // Semana corre domingo → sábado (weekStartsOn: 0).
    const domingoActual = startOfWeek(new Date(), { weekStartsOn: 0 })
    const semanas = []
    for (let i = -2; i <= 1; i++) {
      const inicio = i < 0 ? subWeeks(domingoActual, -i) : addDays(domingoActual, i * 7)
      const fin = addDays(inicio, 6)
      const estado = i < 0 ? 'cerrada' : 'abierta'
      const sem = await prisma.semana.create({
        data: {
          fechaInicio: inicio,
          fechaFin: fin,
          estado,
          cerradaPor: estado === 'cerrada' ? coordinador.id : null,
          cerradaEn: estado === 'cerrada' ? new Date() : null,
        },
      })
      semanas.push({ ...sem, offset: i })
    }
    console.log(`   ✓ ${semanas.length} semanas (${semanas.filter((s) => s.estado === 'cerrada').length} cerradas + ${semanas.filter((s) => s.estado === 'abierta').length} abiertas)`)

    // Plantilla de asignaciones por consultorio (5 días L-V)
    const plantillaConsultorio = (cons, semanaId, intervaloMinPorTipo) => {
      const asigs = []
      // Tipo de recurso según especialidad del consultorio
      const tiposCompat = {
        oftalmologia:   { recursos: oftalmologos, requiereAux: true },
        optometria:     { recursos: optometras,   requiereAux: false },
        anestesiologia: { recursos: anestesiologo ? [anestesiologo] : [], requiereAux: true },
        diagnostico:    { recursos: tecnicos,     requiereAux: false },
      }
      const conf = tiposCompat[cons.especialidad]
      if (!conf || conf.recursos.length === 0) return asigs

      for (let d = 0; d < 5; d++) {
        const dia = DIAS[d]
        const recurso = pick(conf.recursos, d + cons.id.charCodeAt(0))
        const aux = conf.requiereAux ? pick(auxiliares, d + cons.id.charCodeAt(1)) : null

        // Franja matutina
        const hi = '07:00'
        const hf = cons.especialidad === 'optometria' ? '19:00' : '13:00'
        asigs.push({
          semanaId,
          recursoId: recurso.id,
          auxiliarId: aux?.id,
          consultorioId: cons.id,
          diaSemana: dia,
          horaInicio: hi,
          horaFin: hf,
          pacientesCapacidad: capacidad(hi, hf, recurso.intervaloMinutos),
          tieneHorasNocturnas: tieneNocturna(hi, hf),
        })

        // Segunda franja en oftalmología (tarde, médico distinto)
        if (cons.especialidad === 'oftalmologia' && d % 2 === 0) {
          const rec2 = pick(conf.recursos, d + 3)
          const aux2 = pick(auxiliares, d + 5)
          asigs.push({
            semanaId,
            recursoId: rec2.id,
            auxiliarId: aux2.id,
            consultorioId: cons.id,
            diaSemana: dia,
            horaInicio: '14:00',
            horaFin: '18:00',
            pacientesCapacidad: capacidad('14:00', '18:00', rec2.intervaloMinutos),
            tieneHorasNocturnas: false,
          })
        }
      }
      return asigs
    }

    // Crear asignaciones para todas las semanas y todos los consultorios
    let totalAsigs = 0
    for (const sem of semanas) {
      // En las semanas pasadas (cerradas) ponemos asignaciones en TODOS los consultorios
      // En la actual y futura, en la mayoría (90%)
      const consultoriosSemana = sem.offset < 0
        ? consultorios
        : consultorios.filter((_, idx) => idx % 10 !== 0)

      for (const c of consultoriosSemana) {
        const asigs = plantillaConsultorio(c, sem.id)
        for (const a of asigs) {
          await prisma.asignacion.create({ data: a }).catch(() => {})
          totalAsigs++
        }
      }
    }
    console.log(`   ✓ ${totalAsigs} asignaciones distribuidas en ${semanas.length} semanas`)

    // ============ 10. EJECUCIONES (solo semanas cerradas — ya pasaron) ============
    let totalEjec = 0
    for (const sem of semanas.filter((s) => s.estado === 'cerrada')) {
      const asigsSem = await prisma.asignacion.findMany({ where: { semanaId: sem.id } })
      for (const a of asigsSem) {
        // 90% se ejecutaron normal, 10% parcial
        const completo = Math.random() > 0.1
        const pacAt = completo
          ? a.pacientesCapacidad
          : Math.floor(a.pacientesCapacidad * (0.5 + Math.random() * 0.4))
        await prisma.ejecucion.create({
          data: {
            asignacionId: a.id,
            pacientesAtendidos: pacAt,
            estadoJornada: completo ? 'completa' : 'parcial',
            observaciones: completo ? null : 'Atención reducida',
            registradoPor: coordinador.id,
          },
        })
        totalEjec++
      }
    }
    console.log(`   ✓ ${totalEjec} ejecuciones registradas`)

    // ============ 11. AUSENCIAS confirmadas (con impacto calculado) ============
    // 3 ausencias en la semana actual + 2 históricas
    const semActual = semanas.find((s) => s.offset === 0)
    const semAnt    = semanas.find((s) => s.offset === -1)

    const ausenciasData = [
      {
        recurso: recursos.find((r) => r.nombre === 'Dr. Escudero'),
        fechaInicio: addDays(semActual.fechaInicio, 1), // martes
        fechaFin:    addDays(semActual.fechaInicio, 1),
        tipo: 'no_presentacion',
        motivo: 'No se presentó al consultorio asignado',
      },
      {
        recurso: recursos.find((r) => r.nombre === 'Yasiris Trespalacios'),
        fechaInicio: addDays(semActual.fechaInicio, 0),
        fechaFin:    addDays(semActual.fechaInicio, 1),
        tipo: 'enfermedad',
        motivo: 'Incapacidad médica por gripe',
      },
      {
        recurso: recursos.find((r) => r.nombre === 'Doraine Barrios'),
        fechaInicio: addDays(semActual.fechaInicio, 3), // jueves
        fechaFin:    addDays(semActual.fechaInicio, 4),
        tipo: 'familiar',
        motivo: 'Evento familiar programado',
      },
      // Históricas
      {
        recurso: recursos.find((r) => r.nombre === 'Yurley Pua'),
        fechaInicio: addDays(semAnt.fechaInicio, 2),
        fechaFin:    addDays(semAnt.fechaInicio, 2),
        tipo: 'calamidad',
        motivo: 'Calamidad doméstica',
      },
      {
        recurso: recursos.find((r) => r.nombre === 'Ana Nuñez'),
        fechaInicio: addDays(semAnt.fechaInicio, 4),
        fechaFin:    addDays(semAnt.fechaInicio, 4),
        tipo: 'enfermedad',
        motivo: 'Cita médica',
      },
    ]

    for (const a of ausenciasData) {
      if (!a.recurso) continue
      // Crear como pendiente, luego "confirmar" calculando impacto manualmente
      const ausencia = await prisma.ausencia.create({
        data: {
          recursoId: a.recurso.id,
          fechaInicio: a.fechaInicio,
          fechaFin: a.fechaFin,
          tipo: a.tipo,
          motivo: a.motivo,
          esProgramada: false,
          anticipacionDias: 0,
          estado: 'confirmada',
          reportadoPor: a.recurso.nombre === 'Angela Sarmiento' ? usuariosCreados.recurso.id : coordinador.id,
          confirmadoPor: coordinador.id,
          confirmadoEn: new Date(),
        },
      })

      // Calcular impacto: pacientes y costo
      const dias = []
      for (let d = new Date(a.fechaInicio); d <= a.fechaFin; d.setDate(d.getDate() + 1)) {
        dias.push({ fecha: format(d, 'yyyy-MM-dd'), dia: DIAS[(d.getDay() + 6) % 7] })
      }
      let pacImpactados = 0
      let costoOport = 0
      const impactoPorDia = []
      const costoCitaMap = {
        oftalmologia: 150000, optometria: 50000, anestesiologia: 250000, diagnostico: 80000,
      }
      for (const { fecha, dia } of dias) {
        // El recurso puede aparecer como titular O como auxiliar (RN-18)
        const asigsDia = await prisma.asignacion.findMany({
          where: {
            OR: [{ recursoId: a.recurso.id }, { auxiliarId: a.recurso.id }],
            diaSemana: dia,
            estado: { not: 'cancelada' },
          },
          include: { consultorio: true },
        })
        let pacDia = 0
        let costoDia = 0
        for (const asig of asigsDia) {
          pacDia += asig.pacientesCapacidad
          costoDia += asig.pacientesCapacidad * (costoCitaMap[asig.consultorio.especialidad] ?? 0)
        }
        pacImpactados += pacDia
        costoOport += costoDia
        impactoPorDia.push({ fecha, dia, pacientes: pacDia, costo: costoDia })
      }

      await prisma.ausencia.update({
        where: { id: ausencia.id },
        data: {
          pacientesImpactados: pacImpactados,
          costoOportunidad: costoOport,
          impactoPorDia,
        },
      })

      // RN-24: si es oftalmólogo o anestesiólogo, marcar asignaciones sin_cobertura
      if (['oftalmologo', 'anestesiologo'].includes(a.recurso.tipo)) {
        await prisma.asignacion.updateMany({
          where: {
            recursoId: a.recurso.id,
            diaSemana: { in: dias.map((d) => d.dia) },
            estado: 'activa',
          },
          data: { estado: 'sin_cobertura' },
        })
      }
    }
    console.log(`   ✓ ${ausenciasData.filter((a) => a.recurso).length} ausencias confirmadas con impacto`)

    // ============ 12. NOTIFICACIONES iniciales para María (coordinadora) ============
    const notifs = [
      {
        tipo: 'ausencia_reportada',
        titulo: 'Ausencia confirmada — Dr. Escudero',
        mensaje: 'Dr. Escudero registró ausencia para el martes. Revisa el impacto en pacientes.',
        canal: 'app',
      },
      {
        tipo: 'recurso_ocioso',
        titulo: 'Ana Nuñez tiene 5h sin asignar esta semana',
        mensaje: 'Costo fijo subutilizado. Considera asignarle horas o backoffice.',
        canal: 'app',
      },
      {
        tipo: 'consultorio_sin_asignar',
        titulo: 'Cons. 9 sin asignaciones el miércoles',
        mensaje: 'El consultorio Cons. 9 no tiene asignación el miércoles. Programa un recurso.',
        canal: 'app',
      },
    ]
    for (const n of notifs) {
      await prisma.notificacion.create({
        data: { ...n, usuarioId: coordinador.id, enviada: true },
      })
    }
    console.log(`   ✓ ${notifs.length} notificaciones iniciales`)
  }

  console.log('')
  console.log('✅ Seed completado.')
  console.log('   Login con cualquiera (password: Admin123):')
  console.log('   - angela.sarmiento@cofca.co  (recurso · auxiliar)')
  console.log('   - maria.lopez@cofca.co       (coordinador BQ1+BQ2)')
  console.log('   - pedro.rodriguez@cofca.co   (coordinador SM+CTG)')
  console.log('   - carlos.reyes@cofca.co      (directivo)')
  console.log('   - desarrollo@cofca.com       (supervisor)')
}

main()
  .catch((e) => {
    console.error('❌ Error en seed:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
