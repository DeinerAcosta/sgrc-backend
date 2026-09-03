-- Agrega 'gerencia' al enum Rol. Es el rol más alto: super-usuario por
-- encima de supervisor. Ve dashboards ejecutivos + administración total.
ALTER TABLE `usuarios`
  MODIFY `rol` ENUM('recurso','coordinador','directivo','supervisor','gerencia') NOT NULL;
