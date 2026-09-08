import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()

const ejecs = await p.execution.count()
const asigs = await p.assignment.count({ where: { status: { not: 'cancelada' } } })
const semanasAbiertas = await p.week.count({ where: { status: 'abierta' } })
const semanasCerradas = await p.week.count({ where: { status: 'cerrada' } })
const ausencias = await p.absence.count()
const recursos = await p.resource.count({ where: { active: true } })
const usuariosActivos = await p.user.count({ where: { active: true } })

console.log('Ejecuciones registradas:    ', ejecs)
console.log('Asignaciones (no canceladas):', asigs)
console.log('Semanas abiertas:           ', semanasAbiertas)
console.log('Semanas cerradas:           ', semanasCerradas)
console.log('Ausencias registradas:      ', ausencias)
console.log('Recursos activos:           ', recursos)
console.log('Usuarios activos:           ', usuariosActivos)

// Para Productividad: cuántas asignaciones tienen ejecucion vinculada
const asigsConEjec = await p.assignment.count({ where: { execution: { isNot: null } } })
console.log('')
console.log('Asignaciones CON ejecucion registrada:', asigsConEjec)
console.log('Asignaciones SIN ejecucion registrada:', asigs - asigsConEjec)

await p.$disconnect()
