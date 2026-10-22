import { Router } from 'express'
import { requireAuth, requireRol } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/error.js'

import * as auth from '../controllers/authController.js'
import * as sede from '../controllers/siteController.js'
import * as bloqueo from '../controllers/siteBlockController.js'
import * as cons from '../controllers/roomController.js'
import * as rec from '../controllers/resourceController.js'
import * as usr from '../controllers/userController.js'
import * as solReg from '../controllers/signupRequestController.js'
import * as solRec from '../controllers/resourceRequestController.js'
import * as horarioDiario from '../controllers/dailyScheduleController.js'
import * as param from '../controllers/settingController.js'
import * as tareasBo from '../controllers/backofficeTaskController.js'
import * as fest from '../controllers/holidayController.js'
import * as motivoAus from '../controllers/absenceReasonController.js'
import * as reposicion from '../controllers/makeupController.js'
import * as reprogDash from '../controllers/reschedulesDashboardController.js'
import * as semn from '../controllers/weekController.js'
import * as asig from '../controllers/assignmentController.js'
import * as aus from '../controllers/absenceController.js'
import * as ejec from '../controllers/executionController.js'
import * as boff from '../controllers/backofficeController.js'
import * as inf from '../controllers/reportController.js'
import * as notif from '../controllers/notificationController.js'
import * as audit from '../controllers/auditController.js'
import * as job from '../controllers/jobController.js'

const r = Router()
const wrap = asyncHandler

// ============ AUTH (públicos) ============
r.post('/auth/login', wrap(auth.login))
r.post('/auth/refresh', wrap(auth.refresh))
r.post('/auth/forgot-password', wrap(auth.forgotPassword))
r.post('/auth/reset-password', wrap(auth.resetPassword))
r.post('/auth/signup', wrap(auth.registro))   // Registro público (queda pendiente de aprobación)

// A partir de aquí — todo requiere autenticación
r.use(requireAuth)

r.post('/auth/change-password', wrap(auth.cambiarPassword))

// Perfil propio
r.get('/users/me', wrap(auth.me))
r.put('/users/me/heartbeat', wrap(usr.heartbeat))
r.put('/users/me', wrap(usr.updateMe))

// ============ SEDES ============
r.get('/sites', wrap(sede.list))
r.get('/sites/:id', wrap(sede.getById))
r.post('/sites', requireRol('supervisor'), wrap(sede.create))
r.put('/sites/:id', requireRol('supervisor'), wrap(sede.update))
// 3583 · Bloqueo de una sede completa. Lo ve quien programa; lo ponen y lo
// levantan supervisor y gerencia (gerencia pasa todas las puertas).
r.get('/site-blocks', requireRol('coordinador', 'supervisor', 'directivo'), wrap(bloqueo.list))
r.post('/site-blocks', requireRol('supervisor'), wrap(bloqueo.create))
r.put('/site-blocks/:id/lift', requireRol('supervisor'), wrap(bloqueo.lift))
r.get('/sites/:id/rooms', wrap(sede.rooms))

// ============ CONSULTORIOS ============
r.get('/rooms', wrap(cons.list))
r.post('/rooms', requireRol('supervisor'), wrap(cons.create))
r.put('/rooms/:id', requireRol('coordinador', 'supervisor'), wrap(cons.update))
r.delete('/rooms/:id', requireRol('supervisor'), wrap(cons.remove))

// ============ RECURSOS ============
// IMPORTANTE: las rutas estáticas (/recursos/sugeridos) deben ir ANTES de
// las dinámicas (/recursos/:id), si no Express interpreta "sugeridos" como :id.
r.get('/resources', wrap(rec.list))
r.get('/resources/suggested', requireRol('coordinador', 'supervisor'), wrap(asig.sugerirReemplazos))
r.get('/assistants/available', requireRol('coordinador', 'supervisor'), wrap(rec.liberadas))
r.get('/resources/:id/schedule', wrap(rec.horario))
r.get('/resources/:id/absences', wrap(rec.ausenciasDelRecurso))
r.get('/resources/:id/productivity', requireRol('directivo', 'supervisor'), wrap(rec.productividad))
r.get('/resources/:id', wrap(rec.getById))
r.post('/resources', requireRol('supervisor'), wrap(rec.create))
r.get('/resources/:id/dependencies', requireRol('supervisor'), wrap(rec.dependencias))
r.put('/resources/:id', requireRol('supervisor'), wrap(rec.update))
// Sep-2026: no existia forma de borrar un recurso. Solo supervisor, y el
// controlador se niega si tiene historial (responde 409 con el detalle).
r.delete('/resources/:id', requireRol('supervisor'), wrap(rec.remove))

// ============ USUARIOS (admin) ============
r.get('/users', requireRol('supervisor'), wrap(usr.list))
r.post('/users', requireRol('supervisor'), wrap(usr.create))
r.post('/users/bulk', requireRol('supervisor'), wrap(usr.bulkCreate))
r.put('/users/:id', requireRol('supervisor'), wrap(usr.update))
r.delete('/users/:id', requireRol('supervisor'), wrap(usr.remove))
r.post('/users/:id/resend-credentials', requireRol('supervisor'), wrap(usr.reenviarCredenciales))
// Sep-2026 · Ley 2101 · Lista de directivos activos para el modal Nueva
// Asignación cuando un aux va a trabajar sáb+dom (autorización obligatoria).
// El coord tiene que poder consultarla desde el modal, por eso está abierta.
r.get('/users/directivos', requireRol('coordinador', 'supervisor', 'gerencia'), wrap(usr.listDirectivos))
// Oct-2026 · Para el select de "asignar la reprogramacion a".
r.get('/users/reschedulers', requireRol('coordinador', 'supervisor', 'gerencia', 'reprogramador'), wrap(usr.listReprogramadores))
// Solicitudes de registro (autorregistro pendiente de aprobación)
r.get('/users/requests', requireRol('supervisor'), wrap(solReg.list))
r.post('/users/requests/:id/approve', requireRol('supervisor'), wrap(solReg.aprobar))
r.post('/users/requests/:id/reject', requireRol('supervisor'), wrap(solReg.rechazar))

// ============ PARÁMETROS ============
r.get('/cost-settings', wrap(param.listCosto))
r.post('/cost-settings', requireRol('supervisor'), wrap(param.createCosto))
// El frontend llamaba a este PUT desde siempre y no estaba registrado: daba 404
// y el supervisor no podía corregir un costo sin crear otro encima.
r.put('/cost-settings/:id', requireRol('supervisor'), wrap(param.updateCosto))
r.get('/system-settings', wrap(param.getSistema))
r.put('/system-settings', requireRol('supervisor'), wrap(param.updateSistema))

// ============ TAREAS BACKOFFICE ============
r.get('/backoffice-tasks', wrap(tareasBo.list))
r.post('/backoffice-tasks/request', requireRol('coordinador', 'supervisor'), wrap(tareasBo.solicitar))
r.post('/backoffice-tasks/:id/approve', requireRol('supervisor'), wrap(tareasBo.aprobarSolicitud))
r.post('/backoffice-tasks/:id/reject', requireRol('supervisor'), wrap(tareasBo.rechazarSolicitud))
r.post('/backoffice-tasks', requireRol('supervisor'), wrap(tareasBo.create))
r.put('/backoffice-tasks/:id', requireRol('supervisor'), wrap(tareasBo.update))

// ============ FESTIVOS ============
r.get('/holidays', wrap(fest.list))
r.get('/holidays/colombia-calendar', wrap(fest.previewColombia))
r.post('/holidays', requireRol('supervisor'), wrap(fest.create))
r.post('/holidays/sync-colombia', requireRol('supervisor'), wrap(fest.sincronizarColombia))
r.delete('/holidays/:date', requireRol('supervisor'), wrap(fest.remove))

// ============ MOTIVOS DE AUSENCIA (catálogo editable) ============
// Lectura: cualquier autenticado (el modal de registrar ausencia lo consume).
// Edición: solo gerencia/supervisor. Los esSistema=true no se pueden borrar.
r.get('/absence-reasons', wrap(motivoAus.list))
r.get('/absence-reasons/families', wrap(motivoAus.listarFamilias))
r.get('/absence-reasons/:id', requireRol('supervisor', 'gerencia'), wrap(motivoAus.getById))
r.post('/absence-reasons', requireRol('supervisor', 'gerencia'), wrap(motivoAus.crear))
r.put('/absence-reasons/:id', requireRol('supervisor', 'gerencia'), wrap(motivoAus.actualizar))
r.delete('/absence-reasons/:id', requireRol('supervisor', 'gerencia'), wrap(motivoAus.desactivar))

// ============ SEMANAS ============
r.get('/weeks', wrap(semn.list))
r.post('/weeks', requireRol('coordinador', 'supervisor'), wrap(semn.create))
r.put('/weeks/:id/close', requireRol('coordinador', 'supervisor', 'gerencia'), wrap(semn.cerrar))
r.get('/weeks/:id/status-by-site', wrap(semn.estadoPorSede))
r.post('/weeks/:id/copy', requireRol('coordinador', 'supervisor'), wrap(semn.copiar))
// Oct-2026 · PROYECTOS-3398 §7 · Quien falto la semana anterior y todavia no
// tiene horas en la semana que se esta armando. Alimenta el aviso del
// Programador y el resaltado de las casillas.
r.get('/weeks/:id/previous-absences', wrap(semn.ausentesSemanaAnterior))
r.get('/weeks/:id/changes', requireRol('coordinador', 'supervisor', 'gerencia'), wrap(semn.cambiosDeLaSemana))
// Oct-2026 · Las ausencias que caen DENTRO de la semana que se esta viendo, con
// el dia exacto, para que el Programador pinte la casilla en rojo.
//
// CERRADO POR ROL. Nacio sin requireRol con un comentario que decia que el
// controlador recortaba por rol — y no lo hacia. Un rol 'recurso' podia leer
// las ausencias de toda la semana con su motivo, y los motivos incluyen salud
// ('incapacidad por enfermedad', 'cita medica'). Lo consume solo el
// Programador, que abren estos cuatro roles.
r.get('/weeks/:id/absences', requireRol('coordinador', 'supervisor', 'gerencia', 'reprogramador'), wrap(semn.ausenciasDeLaSemana))

// ============ ASIGNACIONES ============
r.get('/assignments', wrap(asig.list))
r.get('/assignments/export', wrap(asig.exportarSemana))
r.post('/assignments', requireRol('coordinador', 'supervisor'), wrap(asig.create))
r.put('/assignments/:id', requireRol('coordinador', 'supervisor'), wrap(asig.update))
r.delete('/assignments/:id', requireRol('coordinador', 'supervisor'), wrap(asig.remove))
// 3739 · Turno en contingencia: lo marca el coordinador; lo aprueba la líder o gerencia.
r.put('/assignments/:id/contingency', requireRol('coordinador', 'supervisor', 'gerencia'), wrap(asig.marcarContingencia))
r.put('/assignments/:id/contingency/approve', requireRol('supervisor', 'gerencia'), wrap(asig.aprobarContingencia))
r.patch('/assignments/:id/patient-capacity', requireRol('coordinador', 'supervisor', 'gerencia', 'recurso'), wrap(asig.actualizarPacientesCapacidad))
r.post('/assignments/copy-day', requireRol('coordinador', 'supervisor', 'gerencia'), wrap(asig.copiarDia))
r.post('/assignments/copy-room', requireRol('coordinador', 'supervisor', 'gerencia'), wrap(asig.copiarConsultorio))
r.post('/assignments/:id/copy-to-days', requireRol('coordinador', 'supervisor', 'gerencia'), wrap(asig.copiarAsignacionADias))

// ============ AUSENCIAS ============
r.get('/absences', wrap(aus.list))
r.post('/absences', wrap(aus.create))
r.get('/absences/data-consent', wrap(aus.autorizacionDatos))
// Oct-2026 · Sin 'reprogramador'. Ese rol es el de quien RECIBE el encargo y
// llama a los pacientes; decidir si una ausencia ocurrió no es lo suyo. Se
// quedó aquí de cuando el rol era el de la líder, y le dejaba confirmar o
// rechazar cualquier ausencia escribiendo la dirección.
r.put('/absences/:id/confirm', requireRol('coordinador', 'supervisor', 'gerencia'), wrap(aus.confirmar))
r.put('/absences/:id/reject', requireRol('coordinador', 'supervisor', 'gerencia'), wrap(aus.rechazar))
// Oct-2026 · Todo lo que la pantalla de reemplazo necesita de un solo viaje:
// las franjas que se cayeron con sede, consultorio, horario y coordinador.
//
// CERRADO POR ROL, por lo mismo que el de arriba: cualquier autenticado podia
// pedir el caso de cualquier profesional y ver su motivo de ausencia, cuantos
// pacientes dejo y donde atendia.
r.get('/absences/:id/replacement-context', requireRol('coordinador', 'supervisor', 'gerencia'), wrap(aus.contextoReemplazo))
// Oct-2026 · La lider asigna la reprogramacion; el reprogramador la cierra.
// SIN 'reprogramador': repartir es el trabajo de la lider, que entra como
// supervisor. Mientras estuvo abierto, quien recibia un encargo podia
// reasignarlo a un companero o echarse encima los casos de los demas.
r.put('/absences/:id/rescheduler', requireRol('coordinador', 'supervisor', 'gerencia'), wrap(aus.asignarReprogramador))
// 'coordinador' entra aqui porque la reprogramacion de tecnicos, auxiliares y
// asesores es suya por reparto y nadie se la asigna: sin esto no podia cerrar
// un caso propio. El handler comprueba que sea de su reparto y de su sede.
r.put('/absences/:id/rescheduler/done', requireRol('coordinador', 'supervisor', 'gerencia', 'reprogramador'), wrap(aus.marcarReprogramacionResuelta))

// Oct-2026 · El trabajo real de quien recibe el encargo: llamar y anotar.
// No mueve agendas; registra cuantos contestaron y cuantos no.
r.put('/absences/:id/call-log', requireRol('reprogramador', 'supervisor', 'gerencia'), wrap(aus.registrarLlamadas))
// Oct-2026 · Los pacientes reales del caso: los pone la líder (supervisor) y,
// en su reparto, el coordinador. Quien llama solo los ve.
r.put('/absences/:id/patients', requireRol('coordinador', 'supervisor', 'gerencia'), wrap(aus.corregirPacientes))
r.put('/absences/:id/assistant-cover', requireRol('coordinador', 'supervisor', 'gerencia'), wrap(aus.cubrirAuxiliar))
r.put('/absences/:id/paid', requireRol('coordinador', 'supervisor', 'gerencia'), wrap(aus.corregirRemuneracion))

// La lista de trabajo de quien reprograma: la lider ve los profesionales de
// todas las sedes, el coordinador lo demas de la suya. El reparto lo decide
// alcanceDeReprogramacion en lib/resourceTypes.js, no la pantalla.
r.get('/reschedules/mine', requireRol('coordinador', 'supervisor', 'gerencia', 'reprogramador'), wrap(aus.misReprogramaciones))

// ============ REPOSICIONES DE AUSENCIA (Fase 3) ============
// Lectura abierta (scoping por rol dentro del handler).
// POST: rol=recurso (dueño), coord/sup/gerencia (a nombre del recurso).
// Aprobar/rechazar/realizar: coord/sup/gerencia.
r.get('/makeups',                     wrap(reposicion.list))
r.post('/makeups',                    requireRol('recurso', 'coordinador', 'supervisor', 'gerencia', 'reprogramador'), wrap(reposicion.crear))
r.put('/makeups/:id/approve',         requireRol('coordinador', 'supervisor', 'gerencia', 'reprogramador'), wrap(reposicion.aprobar))
r.put('/makeups/:id/reject',        requireRol('coordinador', 'supervisor', 'gerencia', 'reprogramador'), wrap(reposicion.rechazar))
r.put('/makeups/:id/done',       requireRol('coordinador', 'supervisor', 'gerencia', 'reprogramador'), wrap(reposicion.marcarRealizada))

// ============ EJECUCIÓN ============
r.get('/execution', requireRol('coordinador', 'supervisor', 'gerencia', 'directivo'), wrap(ejec.get))
r.get('/execution/pending', requireRol('coordinador', 'supervisor', 'gerencia'), wrap(ejec.pendientesDelDia))
// Vista del AUXILIAR (rol recurso): sus asignaciones del día
r.get('/execution/my-pending', requireRol('recurso'), wrap(ejec.misPendientesDelDia))
r.post('/execution', requireRol('coordinador', 'supervisor', 'gerencia', 'recurso'), wrap(ejec.create))
r.post('/execution/batch', requireRol('coordinador', 'supervisor', 'gerencia', 'recurso'), wrap(ejec.saveDay))

// ============ BACKOFFICE ============
r.get('/backoffice-assignments', wrap(boff.listAsignaciones))
r.post('/backoffice-assignments', requireRol('coordinador', 'supervisor'), wrap(boff.asignar))
r.get('/backoffice-assignments/pending/:assistantId', wrap(boff.pendientesAuxiliar))
// Mismo caso que el PUT de cost-settings: el frontend la consumía y no existía.
r.get('/backoffice-execution', wrap(boff.listEjecuciones))
r.post('/backoffice-execution', wrap(boff.registrar))

// ============ INFORMES ============
r.get('/reports/occupancy', wrap(inf.ocupacion))
r.get('/reports/advisor-occupancy', wrap(inf.ocupacionAsesores))
r.get('/reports/advisor-indicators', requireRol('coordinador', 'directivo', 'supervisor'), wrap(inf.indicadoresAsesores))
r.get('/reports/productivity', requireRol('coordinador', 'directivo', 'supervisor'), wrap(inf.productividad))

r.get('/reports/absenteeism', requireRol('coordinador', 'directivo', 'supervisor'), wrap(inf.ausentismo))
r.get('/reports/underuse', requireRol('coordinador', 'directivo', 'supervisor'), wrap(inf.subutilizacion))
r.get('/reports/impact', requireRol('directivo', 'supervisor'), wrap(inf.impacto))
r.get('/reports/absenteeism-impact', requireRol('directivo', 'supervisor'), wrap(inf.ausentismoImpacto))
r.get('/reports/hours-planned-vs-actual', requireRol('coordinador', 'directivo', 'supervisor'), wrap(inf.horasProgEjec))
r.get('/reports/week-closures', requireRol('directivo', 'supervisor'), wrap(inf.cierreSemanas))
r.get('/reports/dashboard', requireRol('directivo', 'supervisor'), wrap(inf.dashboard))
// Fase 4 (ago-2026): dashboard gerencial de reprogramaciones — endpoint agregado
// para el nuevo tablero /app/reprogramaciones (gerencia+directivo+supervisor).
// Oct-2026 · Sin 'reprogramador': quien llama ve su propio indicador en Mis
// reprogramaciones, no el tablero de toda la operación. El tablero salió de
// su menú, pero el servidor lo seguía sirviendo a quien escribiera la URL.
r.get('/reports/reschedules-dashboard', requireRol('directivo', 'supervisor', 'gerencia'), wrap(reprogDash.reprogramacionesDashboard))
r.get('/reports/reschedulers', requireRol('directivo', 'supervisor', 'gerencia'), wrap(reprogDash.gestionReprogramadores))
r.get('/reports/comparison', requireRol('directivo', 'supervisor'), wrap(inf.comparativo))
r.get('/reports/:type/export', requireRol('coordinador', 'directivo', 'supervisor'), wrap(inf.exportar))

// ============ SOLICITUDES DE RECURSO (entre sedes) ============
// IMPORTANTE: la ruta estática count-pendientes debe ir ANTES de :id para no
// ser interpretada como un UUID.
r.get('/resource-requests/count-pending', requireRol('supervisor', 'gerencia'), wrap(solRec.countPendientes))
r.get('/resource-requests', wrap(solRec.list))
r.get('/resource-requests/:id', wrap(solRec.getById))
r.post('/resource-requests', requireRol('coordinador'), wrap(solRec.crear))
r.put('/resource-requests/:id/approve', requireRol('supervisor', 'gerencia'), wrap(solRec.aprobar))
r.put('/resource-requests/:id/reject', requireRol('supervisor', 'gerencia'), wrap(solRec.rechazar))
r.put('/resource-requests/:id/link-resource', requireRol('supervisor', 'gerencia'), wrap(solRec.asociarRecurso))
r.delete('/resource-requests/:id', requireRol('coordinador'), wrap(solRec.cancelar))

// ============ NOTIFICACIONES ============
r.get('/notifications', wrap(notif.list))
r.put('/notifications/:id/read', wrap(notif.leer))
r.put('/notifications/read-all', wrap(notif.leerTodas))

r.get('/daily-schedule', wrap(horarioDiario.get))

// ============ AUDITORÍA ============
r.get('/audit', requireRol('supervisor'), wrap(audit.list))

// ============ JOBS (ejecución manual — solo supervisor) ============
r.post('/jobs/run/:name', requireRol('supervisor'), wrap(job.ejecutar))

export default r
