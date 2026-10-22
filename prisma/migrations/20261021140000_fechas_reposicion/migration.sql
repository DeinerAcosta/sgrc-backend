-- Oct-2026 · Hector: vuelve "¿Desea reponer?" al formulario del profesional y,
-- si dice que sí, elige VARIAS fechas en un calendario. `fecha_reposicion_propuesta`
-- (una sola) queda con la primera, para lo que ya la leía.
ALTER TABLE `ausencias`
  ADD COLUMN `fechas_reposicion` JSON NULL;
