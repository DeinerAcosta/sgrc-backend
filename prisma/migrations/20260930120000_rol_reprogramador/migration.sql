-- Sep-30-2026 · Rol `reprogramador`
--
-- Quien reprograma las agendas que se caen por una ausencia. Hoy es UNA sola
-- persona (Maria Duarte Parejo), que venia usando el rol `gerencia` y por eso
-- veia 26 modulos de los que usa dos.
--
-- No se reutilizo `supervisor` para esto, aunque en la clinica nadie lo use:
-- supervisor concentra 29 rutas exclusivas (catalogos, usuarios, parametros,
-- festivos, auditoria). Darselas a Duarte seria lo contrario de acotarle el
-- alcance — podria borrar recursos o cambiar las metas del sistema. Supervisor
-- se queda como el rol de administracion tecnica.
--
-- Solo agrega el valor al enum. NO cambia el rol de nadie: ese movimiento se
-- hace aparte y con nombre y apellido, para que quede en auditoria.

ALTER TABLE `usuarios`
  MODIFY `rol` ENUM('recurso', 'coordinador', 'directivo', 'supervisor', 'gerencia', 'reprogramador') NOT NULL;
