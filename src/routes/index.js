import { Router } from 'express'
import { requireAuth, requireRol } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/error.js'

import * as auth from '../controllers/authController.js'
import * as sede from '../controllers/sedeController.js'
import * as cons from '../controllers/consultorioController.js'
import * as rec from '../controllers/recursoController.js'
import * as usr from '../controllers/usuarioController.js'
import * as solReg from '../controllers/solicitudRegistroController.js'
import * as horarioDiario from '../controllers/horarioDiarioController.js'
import * as param from '../controllers/parametroController.js'
import * as tareasBo from '../controllers/tareaBackofficeController.js'
import * as fest from '../controllers/festivoController.js'
import * as semn from '../controllers/semanaController.js'
import * as asig from '../controllers/asignacionController.js'
import * as aus from '../controllers/ausenciaController.js'
import * as ejec from '../controllers/ejecucionController.js'
import * as boff from '../controllers/backofficeController.js'
import * as inf from '../controllers/informeController.js'
import * as notif from '../controllers/notificacionController.js'
import * as audit from '../controllers/auditoriaController.js'
import * as job from '../controllers/jobController.js'

const r = Router()
const wrap = asyncHandler

// ============ AUTH (públicos) ============
r.post('/auth/login', wrap(auth.login))
r.post('/auth/refresh', wrap(auth.refresh))
r.post('/auth/forgot-password', wrap(auth.forgotPassword))
r.post('/auth/reset-password', wrap(auth.resetPassword))
r.post('/auth/registro', wrap(auth.registro))   // Registro público (queda pendiente de aprobación)

// A partir de aquí — todo requiere autenticación
r.use(requireAuth)

r.post('/auth/cambiar-password', wrap(auth.cambiarPassword))

// Perfil propio
r.get('/usuarios/me', wrap(auth.me))
r.put('/usuarios/me/heartbeat', wrap(usr.heartbeat))
r.put('/usuarios/me', wrap(usr.updateMe))

// ============ SEDES ============
r.get('/sedes', wrap(sede.list))
r.get('/sedes/:id', wrap(sede.getById))
r.post('/sedes', requireRol('supervisor'), wrap(sede.create))
r.put('/sedes/:id', requireRol('supervisor'), wrap(sede.update))
r.get('/sedes/:id/consultorios', wrap(sede.consultorios))

// ============ CONSULTORIOS ============
r.get('/consultorios', wrap(cons.list))
r.post('/consultorios', requireRol('supervisor'), wrap(cons.create))
r.put('/consultorios/:id', requireRol('coordinador', 'supervisor'), wrap(cons.update))

// ============ RECURSOS ============
// IMPORTANTE: las rutas estáticas (/recursos/sugeridos) deben ir ANTES de
// las dinámicas (/recursos/:id), si no Express interpreta "sugeridos" como :id.
r.get('/recursos', wrap(rec.list))
r.get('/recursos/sugeridos', requireRol('coordinador', 'supervisor'), wrap(asig.sugerirReemplazos))
r.get('/auxiliares/liberadas', requireRol('coordinador', 'supervisor'), wrap(rec.liberadas))
r.get('/recursos/:id/horario', wrap(rec.horario))
r.get('/recursos/:id/ausencias', wrap(rec.ausenciasDelRecurso))
r.get('/recursos/:id/productividad', requireRol('directivo', 'supervisor'), wrap(rec.productividad))
r.get('/recursos/:id', wrap(rec.getById))
r.post('/recursos', requireRol('supervisor'), wrap(rec.create))
r.put('/recursos/:id', requireRol('supervisor'), wrap(rec.update))

// ============ USUARIOS (admin) ============
r.get('/usuarios', requireRol('supervisor'), wrap(usr.list))
r.post('/usuarios', requireRol('supervisor'), wrap(usr.create))
r.put('/usuarios/:id', requireRol('supervisor'), wrap(usr.update))
// Solicitudes de registro (autorregistro pendiente de aprobación)
r.get('/usuarios/solicitudes', requireRol('supervisor'), wrap(solReg.list))
r.post('/usuarios/solicitudes/:id/aprobar', requireRol('supervisor'), wrap(solReg.aprobar))
r.post('/usuarios/solicitudes/:id/rechazar', requireRol('supervisor'), wrap(solReg.rechazar))

// ============ PARÁMETROS ============
r.get('/parametros-costo', wrap(param.listCosto))
r.post('/parametros-costo', requireRol('supervisor'), wrap(param.createCosto))
r.get('/parametros-sistema', wrap(param.getSistema))
r.put('/parametros-sistema', requireRol('supervisor'), wrap(param.updateSistema))

// ============ TAREAS BACKOFFICE ============
r.get('/tareas-backoffice', wrap(tareasBo.list))
r.post('/tareas-backoffice/solicitar', requireRol('coordinador', 'supervisor'), wrap(tareasBo.solicitar))
r.post('/tareas-backoffice/:id/aprobar', requireRol('supervisor'), wrap(tareasBo.aprobarSolicitud))
r.post('/tareas-backoffice/:id/rechazar', requireRol('supervisor'), wrap(tareasBo.rechazarSolicitud))
r.post('/tareas-backoffice', requireRol('supervisor'), wrap(tareasBo.create))
r.put('/tareas-backoffice/:id', requireRol('supervisor'), wrap(tareasBo.update))

// ============ FESTIVOS ============
r.get('/festivos', wrap(fest.list))
r.post('/festivos', requireRol('supervisor'), wrap(fest.create))
r.delete('/festivos/:fecha', requireRol('supervisor'), wrap(fest.remove))

// ============ SEMANAS ============
r.get('/semanas', wrap(semn.list))
r.post('/semanas', requireRol('coordinador', 'supervisor'), wrap(semn.create))
r.put('/semanas/:id/cerrar', requireRol('coordinador', 'supervisor'), wrap(semn.cerrar))
r.post('/semanas/:id/copiar', requireRol('coordinador', 'supervisor'), wrap(semn.copiar))

// ============ ASIGNACIONES ============
r.get('/asignaciones', wrap(asig.list))
r.post('/asignaciones', requireRol('coordinador', 'supervisor'), wrap(asig.create))
r.delete('/asignaciones/:id', requireRol('coordinador', 'supervisor'), wrap(asig.remove))

// ============ AUSENCIAS ============
r.get('/ausencias', wrap(aus.list))
r.post('/ausencias', wrap(aus.create))
r.put('/ausencias/:id/confirmar', requireRol('coordinador', 'supervisor'), wrap(aus.confirmar))
r.put('/ausencias/:id/rechazar', requireRol('coordinador', 'supervisor'), wrap(aus.rechazar))

// ============ EJECUCIÓN ============
r.get('/ejecucion', wrap(ejec.get))
r.get('/ejecucion/pendientes', requireRol('coordinador', 'supervisor'), wrap(ejec.pendientesDelDia))
r.post('/ejecucion', requireRol('coordinador', 'supervisor'), wrap(ejec.create))
r.post('/ejecucion/batch', requireRol('coordinador', 'supervisor'), wrap(ejec.saveDay))

// ============ BACKOFFICE ============
r.get('/asignaciones-backoffice', wrap(boff.listAsignaciones))
r.post('/asignaciones-backoffice', requireRol('coordinador', 'supervisor'), wrap(boff.asignar))
r.get('/asignaciones-backoffice/pendientes/:auxiliarId', wrap(boff.pendientesAuxiliar))
r.post('/ejecucion-backoffice', wrap(boff.registrar))

// ============ INFORMES ============
r.get('/informes/ocupacion', wrap(inf.ocupacion))
r.get('/informes/productividad', requireRol('coordinador', 'directivo', 'supervisor'), wrap(inf.productividad))
r.get('/informes/ausentismo', requireRol('coordinador', 'directivo', 'supervisor'), wrap(inf.ausentismo))
r.get('/informes/subutilizacion', requireRol('coordinador', 'directivo', 'supervisor'), wrap(inf.subutilizacion))
r.get('/informes/impacto', requireRol('directivo', 'supervisor'), wrap(inf.impacto))
r.get('/informes/ausentismo-impacto', requireRol('directivo', 'supervisor'), wrap(inf.ausentismoImpacto))
r.get('/informes/horas-prog-ejec', requireRol('coordinador', 'directivo', 'supervisor'), wrap(inf.horasProgEjec))
r.get('/informes/cierre-semanas', requireRol('directivo', 'supervisor'), wrap(inf.cierreSemanas))
r.get('/informes/dashboard', requireRol('directivo', 'supervisor'), wrap(inf.dashboard))
r.get('/informes/comparativo', requireRol('directivo', 'supervisor'), wrap(inf.comparativo))
r.get('/informes/:tipo/export', requireRol('coordinador', 'directivo', 'supervisor'), wrap(inf.exportar))

// ============ NOTIFICACIONES ============
r.get('/notificaciones', wrap(notif.list))
r.put('/notificaciones/:id/leer', wrap(notif.leer))
r.put('/notificaciones/leer-todas', wrap(notif.leerTodas))

r.get('/horario-diario', wrap(horarioDiario.get))

// ============ AUDITORÍA ============
r.get('/auditoria', requireRol('supervisor'), wrap(audit.list))

// ============ JOBS (ejecución manual — solo supervisor) ============
r.post('/jobs/run/:nombre', requireRol('supervisor'), wrap(job.ejecutar))

export default r
