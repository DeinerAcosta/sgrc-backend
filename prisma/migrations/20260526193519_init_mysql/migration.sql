-- CreateTable
CREATE TABLE `usuarios` (
    `id` VARCHAR(191) NOT NULL,
    `nombre` VARCHAR(150) NOT NULL,
    `email` VARCHAR(200) NOT NULL,
    `celular` VARCHAR(20) NULL,
    `password_hash` VARCHAR(255) NOT NULL,
    `rol` ENUM('recurso', 'coordinador', 'directivo', 'supervisor') NOT NULL,
    `recurso_id` VARCHAR(191) NULL,
    `activo` BOOLEAN NOT NULL DEFAULT true,
    `ultimo_login` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `usuarios_email_key`(`email`),
    UNIQUE INDEX `usuarios_recurso_id_key`(`recurso_id`),
    INDEX `usuarios_rol_idx`(`rol`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `password_resets` (
    `id` VARCHAR(191) NOT NULL,
    `usuario_id` VARCHAR(191) NOT NULL,
    `token` VARCHAR(128) NOT NULL,
    `expira_en` DATETIME(3) NOT NULL,
    `usado` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `password_resets_token_key`(`token`),
    INDEX `password_resets_token_idx`(`token`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `usuarios_sedes` (
    `usuario_id` VARCHAR(191) NOT NULL,
    `sede_id` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`usuario_id`, `sede_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sedes` (
    `id` VARCHAR(191) NOT NULL,
    `nombre` VARCHAR(150) NOT NULL,
    `ciudad` VARCHAR(100) NOT NULL,
    `direccion` TEXT NULL,
    `activa` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `sedes_ciudad_idx`(`ciudad`),
    INDEX `sedes_activa_idx`(`activa`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `consultorios` (
    `id` VARCHAR(191) NOT NULL,
    `sede_id` VARCHAR(191) NOT NULL,
    `nombre` VARCHAR(100) NOT NULL,
    `especialidad` ENUM('oftalmologia', 'optometria', 'anestesiologia', 'diagnostico') NOT NULL,
    `requiere_auxiliar` BOOLEAN NOT NULL,
    `activo` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `consultorios_sede_id_idx`(`sede_id`),
    INDEX `consultorios_activo_idx`(`activo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `recursos` (
    `id` VARCHAR(191) NOT NULL,
    `nombre` VARCHAR(150) NOT NULL,
    `tipo` ENUM('oftalmologo', 'optometra', 'anestesiologo', 'auxiliar', 'tecnico') NOT NULL,
    `especialidad` VARCHAR(100) NULL,
    `intervalo_minutos` INTEGER NULL,
    `esquema_pago` ENUM('por_paciente', 'fijo', 'mixto') NOT NULL,
    `horas_max_semana` INTEGER NOT NULL DEFAULT 42,
    `horas_max_dia` INTEGER NOT NULL DEFAULT 10,
    `activo` BOOLEAN NOT NULL DEFAULT true,
    `motivo_inactivacion` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `recursos_tipo_idx`(`tipo`),
    INDEX `recursos_activo_idx`(`activo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `semanas` (
    `id` VARCHAR(191) NOT NULL,
    `fecha_inicio` DATE NOT NULL,
    `fecha_fin` DATE NOT NULL,
    `estado` ENUM('abierta', 'cerrada') NOT NULL DEFAULT 'abierta',
    `cerrada_por` VARCHAR(191) NULL,
    `cerrada_en` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `semanas_fecha_inicio_key`(`fecha_inicio`),
    INDEX `semanas_estado_idx`(`estado`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `asignaciones` (
    `id` VARCHAR(191) NOT NULL,
    `semana_id` VARCHAR(191) NOT NULL,
    `recurso_id` VARCHAR(191) NOT NULL,
    `auxiliar_id` VARCHAR(191) NULL,
    `consultorio_id` VARCHAR(191) NOT NULL,
    `dia_semana` ENUM('lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo') NOT NULL,
    `hora_inicio` VARCHAR(5) NOT NULL,
    `hora_fin` VARCHAR(5) NOT NULL,
    `pacientes_capacidad` INTEGER NOT NULL,
    `es_horas_extras` BOOLEAN NOT NULL DEFAULT false,
    `tiene_horas_nocturnas` BOOLEAN NOT NULL DEFAULT false,
    `es_reemplazo` BOOLEAN NOT NULL DEFAULT false,
    `ausencia_cubierta_id` VARCHAR(191) NULL,
    `estado` ENUM('activa', 'cancelada', 'sin_cobertura') NOT NULL DEFAULT 'activa',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `asignaciones_recurso_id_dia_semana_hora_inicio_idx`(`recurso_id`, `dia_semana`, `hora_inicio`),
    INDEX `asignaciones_auxiliar_id_dia_semana_hora_inicio_idx`(`auxiliar_id`, `dia_semana`, `hora_inicio`),
    INDEX `asignaciones_consultorio_id_dia_semana_idx`(`consultorio_id`, `dia_semana`),
    INDEX `asignaciones_semana_id_idx`(`semana_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ejecucion` (
    `id` VARCHAR(191) NOT NULL,
    `asignacion_id` VARCHAR(191) NOT NULL,
    `pacientes_atendidos` INTEGER NOT NULL,
    `estado_jornada` ENUM('completa', 'parcial', 'no_ejecutada') NOT NULL DEFAULT 'completa',
    `observaciones` TEXT NULL,
    `registrado_por` VARCHAR(191) NOT NULL,
    `registrado_en` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `bloqueado` BOOLEAN NOT NULL DEFAULT false,

    UNIQUE INDEX `ejecucion_asignacion_id_key`(`asignacion_id`),
    INDEX `ejecucion_registrado_en_idx`(`registrado_en`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ausencias` (
    `id` VARCHAR(191) NOT NULL,
    `recurso_id` VARCHAR(191) NOT NULL,
    `fecha_inicio` DATE NOT NULL,
    `fecha_fin` DATE NOT NULL,
    `es_parcial` BOOLEAN NOT NULL DEFAULT false,
    `hora_inicio_ausencia` VARCHAR(5) NULL,
    `hora_fin_ausencia` VARCHAR(5) NULL,
    `tipo` ENUM('enfermedad', 'calamidad', 'academico', 'familiar', 'vacaciones', 'no_presentacion', 'licencia_remunerada', 'licencia_no_remunerada', 'otra') NOT NULL,
    `motivo` TEXT NULL,
    `archivo_adjunto` VARCHAR(500) NULL,
    `es_programada` BOOLEAN NOT NULL DEFAULT false,
    `anticipacion_dias` INTEGER NOT NULL DEFAULT 0,
    `estado` ENUM('pendiente', 'confirmada', 'rechazada') NOT NULL DEFAULT 'pendiente',
    `pacientes_impactados` INTEGER NULL,
    `costo_oportunidad` DECIMAL(12, 2) NULL,
    `costo_personal_inactivo` DECIMAL(12, 2) NULL,
    `quejas_registradas` INTEGER NULL,
    `accion_tomada` TEXT NULL,
    `impacto_por_dia` JSON NULL,
    `motivo_rechazo` TEXT NULL,
    `registrado_por_coordinador` BOOLEAN NOT NULL DEFAULT false,
    `reportado_por` VARCHAR(191) NOT NULL,
    `reportado_en` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `confirmado_por` VARCHAR(191) NULL,
    `confirmado_en` DATETIME(3) NULL,

    INDEX `ausencias_recurso_id_idx`(`recurso_id`),
    INDEX `ausencias_estado_idx`(`estado`),
    INDEX `ausencias_fecha_inicio_idx`(`fecha_inicio`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `parametros_costo` (
    `id` VARCHAR(191) NOT NULL,
    `tipo_consulta` ENUM('oftalmologia', 'optometria', 'anestesiologia', 'diagnostico') NOT NULL,
    `costo_cita` DECIMAL(12, 2) NOT NULL,
    `costo_reprogramacion` DECIMAL(12, 2) NOT NULL,
    `vigente_desde` DATE NOT NULL,
    `configurado_por` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `parametros_costo_tipo_consulta_vigente_desde_idx`(`tipo_consulta`, `vigente_desde`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `parametros_sistema` (
    `clave` VARCHAR(100) NOT NULL,
    `valor` JSON NOT NULL,
    `motivo` TEXT NULL,
    `updated_by` VARCHAR(191) NULL,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`clave`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tareas_backoffice` (
    `id` VARCHAR(191) NOT NULL,
    `nombre` VARCHAR(150) NOT NULL,
    `descripcion` TEXT NULL,
    `tiempo_estimado_minutos` INTEGER NOT NULL,
    `activa` BOOLEAN NOT NULL DEFAULT true,
    `creada_por` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `tareas_backoffice_activa_idx`(`activa`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `asignaciones_backoffice` (
    `id` VARCHAR(191) NOT NULL,
    `auxiliar_id` VARCHAR(191) NOT NULL,
    `sede_id` VARCHAR(191) NOT NULL,
    `tarea_backoffice_id` VARCHAR(191) NOT NULL,
    `ausencia_origen_id` VARCHAR(191) NULL,
    `dia` DATE NOT NULL,
    `hora_inicio` VARCHAR(5) NOT NULL,
    `hora_fin` VARCHAR(5) NOT NULL,
    `asignado_por` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `asignaciones_backoffice_auxiliar_id_dia_idx`(`auxiliar_id`, `dia`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ejecucion_backoffice` (
    `id` VARCHAR(191) NOT NULL,
    `asignacion_backoffice_id` VARCHAR(191) NOT NULL,
    `tarea_id` VARCHAR(191) NOT NULL,
    `unidades_completadas` INTEGER NOT NULL,
    `tiempo_real_minutos` INTEGER NOT NULL,
    `observaciones` TEXT NULL,
    `registrado_por` VARCHAR(191) NOT NULL,
    `registrado_en` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ejecucion_backoffice_asignacion_backoffice_id_idx`(`asignacion_backoffice_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `festivos` (
    `fecha` DATE NOT NULL,
    `descripcion` VARCHAR(200) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`fecha`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notificaciones` (
    `id` VARCHAR(191) NOT NULL,
    `usuario_id` VARCHAR(191) NOT NULL,
    `tipo` VARCHAR(50) NOT NULL,
    `titulo` VARCHAR(200) NOT NULL,
    `mensaje` TEXT NOT NULL,
    `canal` ENUM('app', 'email', 'whatsapp') NOT NULL,
    `leida` BOOLEAN NOT NULL DEFAULT false,
    `enviada` BOOLEAN NOT NULL DEFAULT false,
    `referencia_id` VARCHAR(191) NULL,
    `creada_en` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `notificaciones_usuario_id_leida_idx`(`usuario_id`, `leida`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `auditoria` (
    `id` VARCHAR(191) NOT NULL,
    `usuario_id` VARCHAR(191) NOT NULL,
    `accion` VARCHAR(100) NOT NULL,
    `entidad` VARCHAR(50) NOT NULL,
    `entidad_id` VARCHAR(191) NOT NULL,
    `valor_anterior` JSON NULL,
    `valor_nuevo` JSON NULL,
    `motivo` TEXT NULL,
    `ip_address` VARCHAR(45) NULL,
    `creada_en` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `auditoria_usuario_id_idx`(`usuario_id`),
    INDEX `auditoria_accion_idx`(`accion`),
    INDEX `auditoria_entidad_entidad_id_idx`(`entidad`, `entidad_id`),
    INDEX `auditoria_creada_en_idx`(`creada_en`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `usuarios` ADD CONSTRAINT `usuarios_recurso_id_fkey` FOREIGN KEY (`recurso_id`) REFERENCES `recursos`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `password_resets` ADD CONSTRAINT `password_resets_usuario_id_fkey` FOREIGN KEY (`usuario_id`) REFERENCES `usuarios`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `usuarios_sedes` ADD CONSTRAINT `usuarios_sedes_usuario_id_fkey` FOREIGN KEY (`usuario_id`) REFERENCES `usuarios`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `usuarios_sedes` ADD CONSTRAINT `usuarios_sedes_sede_id_fkey` FOREIGN KEY (`sede_id`) REFERENCES `sedes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consultorios` ADD CONSTRAINT `consultorios_sede_id_fkey` FOREIGN KEY (`sede_id`) REFERENCES `sedes`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `asignaciones` ADD CONSTRAINT `asignaciones_semana_id_fkey` FOREIGN KEY (`semana_id`) REFERENCES `semanas`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `asignaciones` ADD CONSTRAINT `asignaciones_recurso_id_fkey` FOREIGN KEY (`recurso_id`) REFERENCES `recursos`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `asignaciones` ADD CONSTRAINT `asignaciones_auxiliar_id_fkey` FOREIGN KEY (`auxiliar_id`) REFERENCES `recursos`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `asignaciones` ADD CONSTRAINT `asignaciones_consultorio_id_fkey` FOREIGN KEY (`consultorio_id`) REFERENCES `consultorios`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `asignaciones` ADD CONSTRAINT `asignaciones_ausencia_cubierta_id_fkey` FOREIGN KEY (`ausencia_cubierta_id`) REFERENCES `ausencias`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ejecucion` ADD CONSTRAINT `ejecucion_asignacion_id_fkey` FOREIGN KEY (`asignacion_id`) REFERENCES `asignaciones`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ausencias` ADD CONSTRAINT `ausencias_recurso_id_fkey` FOREIGN KEY (`recurso_id`) REFERENCES `recursos`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `asignaciones_backoffice` ADD CONSTRAINT `asignaciones_backoffice_auxiliar_id_fkey` FOREIGN KEY (`auxiliar_id`) REFERENCES `recursos`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `asignaciones_backoffice` ADD CONSTRAINT `asignaciones_backoffice_sede_id_fkey` FOREIGN KEY (`sede_id`) REFERENCES `sedes`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `asignaciones_backoffice` ADD CONSTRAINT `asignaciones_backoffice_tarea_backoffice_id_fkey` FOREIGN KEY (`tarea_backoffice_id`) REFERENCES `tareas_backoffice`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `asignaciones_backoffice` ADD CONSTRAINT `asignaciones_backoffice_ausencia_origen_id_fkey` FOREIGN KEY (`ausencia_origen_id`) REFERENCES `ausencias`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ejecucion_backoffice` ADD CONSTRAINT `ejecucion_backoffice_asignacion_backoffice_id_fkey` FOREIGN KEY (`asignacion_backoffice_id`) REFERENCES `asignaciones_backoffice`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notificaciones` ADD CONSTRAINT `notificaciones_usuario_id_fkey` FOREIGN KEY (`usuario_id`) REFERENCES `usuarios`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `auditoria` ADD CONSTRAINT `auditoria_usuario_id_fkey` FOREIGN KEY (`usuario_id`) REFERENCES `usuarios`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
