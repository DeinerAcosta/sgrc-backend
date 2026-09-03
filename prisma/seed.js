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
    { name: 'Sede 1 Barranquilla', city: 'Barranquilla', address: 'Cl. 76 #50-10' },
    { name: 'Sede 2 Barranquilla', city: 'Barranquilla', address: 'Cra. 53 #80-32' },
    { name: 'Sede Santa Marta',    city: 'Santa Marta',  address: 'Cl. 22 #4-30' },
    { name: 'Sede Cartagena',      city: 'Cartagena',    address: 'Av. San Martín' },
    { name: 'Sede Valledupar',     city: 'Valledupar',   address: 'Cra. 19 #16-50' },
    { name: 'Sede Riohacha',       city: 'Riohacha',     address: 'Cl. 15 #7-20' },
    { name: 'Sede Sabanalarga',    city: 'Sabanalarga',  address: 'Cl. 20 #19-15' },
  ]
  const sedes = []
  for (const s of sedesData) {
    const existente = await prisma.site.findFirst({ where: { name: s.name } })
    const sede = existente
      ? await prisma.site.update({ where: { id: existente.id }, data: s })
      : await prisma.site.create({ data: s })
    sedes.push(sede)
  }
  console.log(`   ✓ ${sedes.length} sedes`)

  // Helper para indexar por nombre
  const sedeBQ1 = sedes.find((s) => s.name === 'Sede 1 Barranquilla')
  const sedeBQ2 = sedes.find((s) => s.name === 'Sede 2 Barranquilla')
  const sedeSM  = sedes.find((s) => s.name === 'Sede Santa Marta')
  const sedeCTG = sedes.find((s) => s.name === 'Sede Cartagena')
  const sedeVPA = sedes.find((s) => s.name === 'Sede Valledupar')
  const sedeRCH = sedes.find((s) => s.name === 'Sede Riohacha')
  const sedeSNL = sedes.find((s) => s.name === 'Sede Sabanalarga')

  // ============ 2. CONSULTORIOS — en TODAS las sedes ============
  const consultoriosData = [
    // BQ1
    { site: sedeBQ1, name: 'Cons. 1', specialty: 'oftalmologia' },
    { site: sedeBQ1, name: 'Cons. 2', specialty: 'oftalmologia' },
    { site: sedeBQ1, name: 'Cons. 3', specialty: 'optometria' },
    { site: sedeBQ1, name: 'Cons. 4', specialty: 'optometria' },
    { site: sedeBQ1, name: 'Cons. 5', specialty: 'diagnostico' },
    // BQ2 (los que ya teníamos)
    { site: sedeBQ2, name: 'Cons. 6',  specialty: 'oftalmologia' },
    { site: sedeBQ2, name: 'Cons. 9',  specialty: 'oftalmologia' },
    { site: sedeBQ2, name: 'Cons. 13', specialty: 'optometria' },
    { site: sedeBQ2, name: 'Cons. 14', specialty: 'optometria' },
    { site: sedeBQ2, name: 'Cons. 1 Ec', specialty: 'diagnostico' },
    { site: sedeBQ2, name: 'Cons. 2 An', specialty: 'anestesiologia' },
    // Santa Marta
    { site: sedeSM, name: 'SM-Cons. 1', specialty: 'oftalmologia' },
    { site: sedeSM, name: 'SM-Cons. 2', specialty: 'optometria' },
    { site: sedeSM, name: 'SM-Cons. 3', specialty: 'diagnostico' },
    // Cartagena
    { site: sedeCTG, name: 'CTG-Cons. 1', specialty: 'oftalmologia' },
    { site: sedeCTG, name: 'CTG-Cons. 2', specialty: 'optometria' },
    // Valledupar
    { site: sedeVPA, name: 'VPA-Cons. 1', specialty: 'oftalmologia' },
    { site: sedeVPA, name: 'VPA-Cons. 2', specialty: 'optometria' },
    // Riohacha
    { site: sedeRCH, name: 'RCH-Cons. 1', specialty: 'oftalmologia' },
    { site: sedeRCH, name: 'RCH-Cons. 2', specialty: 'optometria' },
    // Sabanalarga
    { site: sedeSNL, name: 'SNL-Cons. 1', specialty: 'oftalmologia' },
    { site: sedeSNL, name: 'SNL-Cons. 2', specialty: 'optometria' },
  ]
  const REQUIEREN_AUX = new Set(['oftalmologia', 'anestesiologia'])
  const consultorios = []
  for (const c of consultoriosData) {
    const existente = await prisma.room.findFirst({
      where: { name: c.name, siteId: c.site.id },
    })
    const data = {
      siteId: c.site.id,
      name: c.name,
      specialty: c.specialty,
      requiresAssistant: REQUIEREN_AUX.has(c.specialty),
    }
    const cons = existente
      ? await prisma.room.update({ where: { id: existente.id }, data })
      : await prisma.room.create({ data })
    consultorios.push({ ...cons, site: c.site })
  }
  console.log(`   ✓ ${consultorios.length} consultorios en ${sedes.length} sedes`)

  // ============ 3. RECURSOS — variedad realista ============
  const recursosData = [
    // Oftalmólogos
    { name: 'Dr. Rhenals',  type: 'oftalmologo',   specialty: 'Retina',         slotMinutes: 20, payScheme: 'por_paciente', maxHoursPerWeek: 60, maxHoursPerDay: 12 },
    { name: 'Dr. Martínez', type: 'oftalmologo',   specialty: 'Retina',         slotMinutes: 20, payScheme: 'por_paciente', maxHoursPerWeek: 60, maxHoursPerDay: 12 },
    { name: 'Dr. Córnea',   type: 'oftalmologo',   specialty: 'Córnea',         slotMinutes: 20, payScheme: 'por_paciente', maxHoursPerWeek: 60, maxHoursPerDay: 12 },
    { name: 'Dr. Sanabria', type: 'oftalmologo',   specialty: 'Glaucoma',       slotMinutes: 25, payScheme: 'por_paciente', maxHoursPerWeek: 60, maxHoursPerDay: 12 },
    { name: 'Dra. Polo',    type: 'oftalmologo',   specialty: 'Cataratas',      slotMinutes: 30, payScheme: 'por_paciente', maxHoursPerWeek: 60, maxHoursPerDay: 12 },
    // Optómetras
    { name: 'Dr. Gutierrez', type: 'optometra', specialty: 'General', slotMinutes: 15, payScheme: 'mixto' },
    { name: 'Dr. Escudero',  type: 'optometra', specialty: 'General', slotMinutes: 15, payScheme: 'mixto' },
    { name: 'Dra. Meza',     type: 'optometra', specialty: 'Lentes de contacto', slotMinutes: 20, payScheme: 'mixto' },
    { name: 'Dr. Pacheco',   type: 'optometra', specialty: 'Pediátrica', slotMinutes: 20, payScheme: 'mixto' },
    // Anestesiólogo
    { name: 'Dr. Pérez Anest.',  type: 'anestesiologo', specialty: 'Anestesia', slotMinutes: 30, payScheme: 'por_paciente', maxHoursPerWeek: 60, maxHoursPerDay: 12 },
    // Auxiliares
    { name: 'Angela Sarmiento',     type: 'auxiliar', payScheme: 'fijo' },
    { name: 'Alba Tete',            type: 'auxiliar', payScheme: 'fijo' },
    { name: 'Ana Castillo',         type: 'auxiliar', payScheme: 'fijo' },
    { name: 'Ana Nuñez',            type: 'auxiliar', payScheme: 'fijo' },
    { name: 'Cynthia Maury',        type: 'auxiliar', payScheme: 'fijo' },
    { name: 'Darleis Silva',        type: 'auxiliar', payScheme: 'fijo' },
    { name: 'Yasiris Trespalacios', type: 'auxiliar', payScheme: 'fijo' },
    { name: 'Doraine Barrios',      type: 'auxiliar', payScheme: 'fijo' },
    { name: 'Lina Torres',          type: 'auxiliar', payScheme: 'fijo' },
    { name: 'Yurley Pua',           type: 'auxiliar', payScheme: 'fijo' },
    // Técnicos
    { name: 'Tec. Rivera',  type: 'tecnico', slotMinutes: 30, payScheme: 'fijo' },
    { name: 'Tec. Mendez',  type: 'tecnico', slotMinutes: 30, payScheme: 'fijo' },
    { name: 'Tec. Carlos Díaz', type: 'tecnico', slotMinutes: 30, payScheme: 'fijo' },
  ]
  const recursos = []
  for (const r of recursosData) {
    const existente = await prisma.resource.findFirst({ where: { name: r.name } })
    const rec = existente
      ? await prisma.resource.update({ where: { id: existente.id }, data: r })
      : await prisma.resource.create({ data: r })
    recursos.push(rec)
  }
  console.log(`   ✓ ${recursos.length} recursos`)

  const oftalmologos = recursos.filter((r) => r.type === 'oftalmologo')
  const optometras   = recursos.filter((r) => r.type === 'optometra')
  const auxiliares   = recursos.filter((r) => r.type === 'auxiliar')
  const tecnicos     = recursos.filter((r) => r.type === 'tecnico')
  const anestesiologo = recursos.find((r) => r.type === 'anestesiologo')

  // ============ 4. USUARIOS (upsert por email) ============
  const pwHash = await bcrypt.hash(PASS, 12)
  const usuarios = [
    {
      email: 'angela.sarmiento@cofca.co', name: 'Angela Sarmiento', role: 'recurso',
      resourceId: recursos.find((r) => r.name === 'Angela Sarmiento').id, phone: '300 555 0001',
    },
    {
      email: 'maria.lopez@cofca.co', name: 'María López', role: 'coordinador',
      phone: '300 555 0002', sites: [sedeBQ2.id, sedeBQ1.id],
    },
    {
      email: 'pedro.rodriguez@cofca.co', name: 'Pedro Rodríguez', role: 'coordinador',
      phone: '300 555 0003', sites: [sedeSM.id, sedeCTG.id],
    },
    {
      email: 'carlos.reyes@cofca.co', name: 'Carlos Reyes', role: 'directivo',
    },
    {
      // OJO: nunca poner aquí un email REAL. El bloque de abajo hace update sobre
      // el usuario existente y pisa nombre, teléfono, contraseña y sedes. Este email
      // era 'desarrollo@cofca.com' y sobreescribió la cuenta real del usuario.
      email: 'supervisor@cofca.co', name: 'Diana Martínez', role: 'supervisor',
    },
  ]
  const usuariosCreados = {}
  for (const u of usuarios) {
    const sedesRel = u.sites ?? []
    const existente = await prisma.user.findUnique({ where: { email: u.email } })
    let usuario
    if (existente) {
      usuario = await prisma.user.update({
        where: { id: existente.id },
        data: {
          name: u.name,
          phone: u.phone,
          passwordHash: pwHash,
          role: u.role,
          resourceId: u.resourceId,
        },
      })
      // Resetear sedes (idempotente)
      await prisma.userSite.deleteMany({ where: { userId: usuario.id } })
    } else {
      usuario = await prisma.user.create({
        data: {
          email: u.email,
          name: u.name,
          phone: u.phone,
          passwordHash: pwHash,
          role: u.role,
          resourceId: u.resourceId,
        },
      })
    }
    if (sedesRel.length > 0) {
      await prisma.userSite.createMany({
        data: sedesRel.map((sedeId) => ({ userId: usuario.id, siteId: sedeId })),
      })
    }
    usuariosCreados[u.role] = usuario
  }
  const coordinador = usuariosCreados.coordinador // María
  console.log(`   ✓ ${usuarios.length} usuarios (password: ${PASS})`)

  // ============ 5. PARÁMETROS DE COSTO (upsert por tipo + vigencia) ============
  const parametrosCosto = [
    { visitType: 'oftalmologia',   visitCost: 150000, rescheduleCost: 8000 },
    { visitType: 'optometria',     visitCost: 50000,  rescheduleCost: 5000 },
    { visitType: 'anestesiologia', visitCost: 250000, rescheduleCost: 12000 },
    { visitType: 'diagnostico',    visitCost: 80000,  rescheduleCost: 6000 },
  ]
  const vigDate = new Date('2026-01-01')
  for (const p of parametrosCosto) {
    const exists = await prisma.costSetting.findFirst({
      where: { visitType: p.visitType, effectiveFrom: vigDate },
    })
    if (!exists) {
      await prisma.costSetting.create({
        data: { ...p, effectiveFrom: vigDate, setBy: coordinador.id },
      })
    }
  }
  console.log(`   ✓ ${parametrosCosto.length} parámetros de costo`)

  // ============ 6. PARÁMETROS DEL SISTEMA ============
  const parametrosSistema = [
    { key: 'meta_ocupacion_consultorios', value: 80 },
    { key: 'meta_utilizacion_th',         value: 90 },
    { key: 'meta_cumplimiento_ejecucion', value: 85 },
    { key: 'semaforo_umbral_naranja',     value: 10 },
    { key: 'base_horas_lun_vie_min',      value: 720 },
    { key: 'base_horas_sabado_min',       value: 240 },
  ]
  for (const p of parametrosSistema) {
    await prisma.systemSetting.upsert({
      where: { key: p.key },
      update: { value: p.value, updatedBy: usuariosCreados.supervisor.id },
      create: { key: p.key, value: p.value, updatedBy: usuariosCreados.supervisor.id },
    })
  }
  console.log(`   ✓ ${parametrosSistema.length} parámetros del sistema`)

  // ============ 7. TAREAS BACKOFFICE (upsert por nombre) ============
  const tareasBackoffice = [
    { name: 'Confirmación de citas', estimatedMinutes: 5 },
    { name: 'Generación de autorizaciones', estimatedMinutes: 10 },
    { name: 'Llamadas de seguimiento postoperatorio', estimatedMinutes: 8 },
    { name: 'Archivo y digitalización', estimatedMinutes: 3 },
    { name: 'Verificación de historias clínicas', estimatedMinutes: 6 },
    { name: 'Cubrir almuerzos',      description: 'Cubrimiento del horario de almuerzo de otros recursos asistenciales.',         estimatedMinutes: 60 },
    { name: 'Visitas hospitalarias', description: 'Visitas a pacientes hospitalizados.',                                           estimatedMinutes: 90 },
    { name: 'Citas personalizadas',  description: 'Atención de citas personalizadas/agendadas fuera de la consulta regular.',     estimatedMinutes: 30 },
    { name: 'Brigadas',              description: 'Apoyo en brigadas de salud (intramurales o extramurales).',                     estimatedMinutes: 240 },
    { name: 'Apoyo SIAU',            description: 'Apoyo al Servicio de Información y Atención al Usuario (SIAU).',                estimatedMinutes: 60 },
    { name: 'Apoyo Cirugía',         description: 'Apoyo al servicio de cirugía (preparación, instrumentación, postoperatorio).', estimatedMinutes: 120 },
  ]
  const tareasBoCreadas = []
  for (const t of tareasBackoffice) {
    const exists = await prisma.backofficeTask.findFirst({ where: { name: t.name } })
    const tarea = exists
      ? await prisma.backofficeTask.update({ where: { id: exists.id }, data: t })
      : await prisma.backofficeTask.create({
          data: { ...t, createdBy: usuariosCreados.supervisor.id },
        })
    tareasBoCreadas.push(tarea)
  }
  console.log(`   ✓ ${tareasBoCreadas.length} tareas de backoffice`)

  // ============ 8. FESTIVOS ============
  const festivos = [
    { date: new Date('2026-01-01'), description: 'Año Nuevo' },
    { date: new Date('2026-01-12'), description: 'Día de los Reyes Magos' },
    { date: new Date('2026-03-23'), description: 'Día de San José' },
    { date: new Date('2026-04-02'), description: 'Jueves Santo' },
    { date: new Date('2026-04-03'), description: 'Viernes Santo' },
    { date: new Date('2026-05-01'), description: 'Día del Trabajo' },
    { date: new Date('2026-07-20'), description: 'Día de la Independencia' },
    { date: new Date('2026-08-07'), description: 'Batalla de Boyacá' },
    { date: new Date('2026-12-08'), description: 'Inmaculada Concepción' },
    { date: new Date('2026-12-25'), description: 'Navidad' },
  ]
  for (const f of festivos) {
    await prisma.holiday.upsert({
      where: { date: f.date },
      update: { description: f.description },
      create: f,
    })
  }
  console.log(`   ✓ ${festivos.length} festivos`)

  // ============ 9. SEMANAS Y ASIGNACIONES — solo si la BD está vacía de asignaciones ============
  const yaHayAsigs = await prisma.assignment.count()
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
      const sem = await prisma.week.create({
        data: {
          startDate: inicio,
          endDate: fin,
          status: estado,
          closedBy: estado === 'cerrada' ? coordinador.id : null,
          closedAt: estado === 'cerrada' ? new Date() : null,
        },
      })
      semanas.push({ ...sem, offset: i })
    }
    console.log(`   ✓ ${semanas.length} semanas (${semanas.filter((s) => s.status === 'cerrada').length} cerradas + ${semanas.filter((s) => s.status === 'abierta').length} abiertas)`)

    // Plantilla de asignaciones por consultorio (5 días L-V)
    const plantillaConsultorio = (cons, semanaId, intervaloMinPorTipo) => {
      const asigs = []
      // Tipo de recurso según especialidad del consultorio
      const tiposCompat = {
        oftalmologia:   { resources: oftalmologos, requiereAux: true },
        optometria:     { resources: optometras,   requiereAux: false },
        anestesiologia: { resources: anestesiologo ? [anestesiologo] : [], requiereAux: true },
        diagnostico:    { resources: tecnicos,     requiereAux: false },
      }
      const conf = tiposCompat[cons.specialty]
      if (!conf || conf.resources.length === 0) return asigs

      for (let d = 0; d < 5; d++) {
        const dia = DIAS[d]
        const recurso = pick(conf.resources, d + cons.id.charCodeAt(0))
        const aux = conf.requiereAux ? pick(auxiliares, d + cons.id.charCodeAt(1)) : null

        // Franja matutina
        const hi = '07:00'
        const hf = cons.specialty === 'optometria' ? '19:00' : '13:00'
        asigs.push({
          weekId: semanaId,
          resourceId: recurso.id,
          assistantId: aux?.id,
          roomId: cons.id,
          weekday: dia,
          startTime: hi,
          endTime: hf,
          patientCapacity: capacidad(hi, hf, recurso.slotMinutes),
          hasNightHours: tieneNocturna(hi, hf),
        })

        // Segunda franja en oftalmología (tarde, médico distinto)
        if (cons.specialty === 'oftalmologia' && d % 2 === 0) {
          const rec2 = pick(conf.resources, d + 3)
          const aux2 = pick(auxiliares, d + 5)
          asigs.push({
            weekId: semanaId,
            resourceId: rec2.id,
            assistantId: aux2.id,
            roomId: cons.id,
            weekday: dia,
            startTime: '14:00',
            endTime: '18:00',
            patientCapacity: capacidad('14:00', '18:00', rec2.slotMinutes),
            hasNightHours: false,
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
          await prisma.assignment.create({ data: a }).catch(() => {})
          totalAsigs++
        }
      }
    }
    console.log(`   ✓ ${totalAsigs} asignaciones distribuidas en ${semanas.length} semanas`)

    // ============ 10. EJECUCIONES (solo semanas cerradas — ya pasaron) ============
    let totalEjec = 0
    for (const sem of semanas.filter((s) => s.status === 'cerrada')) {
      const asigsSem = await prisma.assignment.findMany({ where: { weekId: sem.id } })
      for (const a of asigsSem) {
        // 90% se ejecutaron normal, 10% parcial
        const completo = Math.random() > 0.1
        const pacAt = completo
          ? a.patientCapacity
          : Math.floor(a.patientCapacity * (0.5 + Math.random() * 0.4))
        await prisma.execution.create({
          data: {
            assignmentId: a.id,
            patientsSeen: pacAt,
            shiftStatus: completo ? 'completa' : 'parcial',
            notes: completo ? null : 'Atención reducida',
            recordedBy: coordinador.id,
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
        resource: recursos.find((r) => r.name === 'Dr. Escudero'),
        startDate: addDays(semActual.startDate, 1), // martes
        endDate:    addDays(semActual.startDate, 1),
        type: 'no_presentacion',
        reason: 'No se presentó al consultorio asignado',
      },
      {
        resource: recursos.find((r) => r.name === 'Yasiris Trespalacios'),
        startDate: addDays(semActual.startDate, 0),
        endDate:    addDays(semActual.startDate, 1),
        type: 'enfermedad',
        reason: 'Incapacidad médica por gripe',
      },
      {
        resource: recursos.find((r) => r.name === 'Doraine Barrios'),
        startDate: addDays(semActual.startDate, 3), // jueves
        endDate:    addDays(semActual.startDate, 4),
        type: 'familiar',
        reason: 'Evento familiar programado',
      },
      // Históricas
      {
        resource: recursos.find((r) => r.name === 'Yurley Pua'),
        startDate: addDays(semAnt.startDate, 2),
        endDate:    addDays(semAnt.startDate, 2),
        type: 'calamidad',
        reason: 'Calamidad doméstica',
      },
      {
        resource: recursos.find((r) => r.name === 'Ana Nuñez'),
        startDate: addDays(semAnt.startDate, 4),
        endDate:    addDays(semAnt.startDate, 4),
        type: 'enfermedad',
        reason: 'Cita médica',
      },
    ]

    for (const a of ausenciasData) {
      if (!a.resource) continue
      // Crear como pendiente, luego "confirmar" calculando impacto manualmente
      const ausencia = await prisma.absence.create({
        data: {
          resourceId: a.resource.id,
          startDate: a.startDate,
          endDate: a.endDate,
          type: a.type,
          reason: a.reason,
          isPlanned: false,
          noticeDays: 0,
          status: 'confirmada',
          reportedBy: a.resource.name === 'Angela Sarmiento' ? usuariosCreados.resource.id : coordinador.id,
          confirmedBy: coordinador.id,
          confirmedAt: new Date(),
        },
      })

      // Calcular impacto: pacientes y costo
      const dias = []
      for (let d = new Date(a.startDate); d <= a.endDate; d.setDate(d.getDate() + 1)) {
        dias.push({ date: format(d, 'yyyy-MM-dd'), day: DIAS[(d.getDay() + 6) % 7] })
      }
      let pacImpactados = 0
      let costoOport = 0
      const impactoPorDia = []
      const costoCitaMap = {
        oftalmologia: 150000, optometria: 50000, anestesiologia: 250000, diagnostico: 80000,
      }
      for (const { date: fecha, day: dia } of dias) {
        // El recurso puede aparecer como titular O como auxiliar (RN-18)
        const asigsDia = await prisma.assignment.findMany({
          where: {
            OR: [{ resourceId: a.resource.id }, { assistantId: a.resource.id }],
            weekday: dia,
            status: { not: 'cancelada' },
          },
          include: { room: true },
        })
        let pacDia = 0
        let costoDia = 0
        for (const asig of asigsDia) {
          pacDia += asig.patientCapacity
          costoDia += asig.patientCapacity * (costoCitaMap[asig.room.specialty] ?? 0)
        }
        pacImpactados += pacDia
        costoOport += costoDia
        impactoPorDia.push({ date: fecha, day: dia, pacientes: pacDia, cost: costoDia })
      }

      await prisma.absence.update({
        where: { id: ausencia.id },
        data: {
          patientsAffected: pacImpactados,
          opportunityCost: costoOport,
          dailyImpact: impactoPorDia,
        },
      })

      // RN-24: si es oftalmólogo o anestesiólogo, marcar asignaciones sin_cobertura
      if (['oftalmologo', 'anestesiologo'].includes(a.resource.type)) {
        await prisma.assignment.updateMany({
          where: {
            resourceId: a.resource.id,
            weekday: { in: dias.map((d) => d.day) },
            status: 'activa',
          },
          data: { status: 'sin_cobertura' },
        })
      }
    }
    console.log(`   ✓ ${ausenciasData.filter((a) => a.resource).length} ausencias confirmadas con impacto`)

    // ============ 12. NOTIFICACIONES iniciales para María (coordinadora) ============
    const notifs = [
      {
        type: 'ausencia_reportada',
        title: 'Ausencia confirmada — Dr. Escudero',
        message: 'Dr. Escudero registró ausencia para el martes. Revisa el impacto en pacientes.',
        channel: 'app',
      },
      {
        type: 'recurso_ocioso',
        title: 'Ana Nuñez tiene 5h sin asignar esta semana',
        message: 'Costo fijo subutilizado. Considera asignarle horas o backoffice.',
        channel: 'app',
      },
      {
        type: 'consultorio_sin_asignar',
        title: 'Cons. 9 sin asignaciones el miércoles',
        message: 'El consultorio Cons. 9 no tiene asignación el miércoles. Programa un recurso.',
        channel: 'app',
      },
    ]
    for (const n of notifs) {
      await prisma.notification.create({
        data: { ...n, userId: coordinador.id, sent: true },
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
