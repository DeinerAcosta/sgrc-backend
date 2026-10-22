/**
 * Los pacientes de un caso de reprogramación: el número REAL que puso la
 * líder, o el que estimó el sistema desde la agenda caída si no lo ha puesto.
 *
 * Oct-2026 · Hector: "en el momento del proceso de repro, en líder es donde
 * pone los datos de los pacientes reales afectados". El estimado sale de la
 * capacidad del turno y a veces son más o menos; el real lo sabe ella.
 *
 * Es el único sitio donde vive esta regla. La usan la cuenta del caso, la
 * lista de reprogramaciones y el tope de pacientes al cubrir: si cada uno
 * eligiera su número, la pantalla diría "faltan 12" y el servidor rechazaría
 * el 11.
 */
export const pacientesDelCaso = (ausencia) =>
  ausencia?.patientsConfirmed ?? ausencia?.patientsAffected ?? 0
