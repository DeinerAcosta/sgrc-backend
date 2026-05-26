-- CreateEnum
CREATE TYPE "Rol" AS ENUM ('recurso', 'coordinador', 'directivo', 'supervisor');

-- CreateEnum
CREATE TYPE "TipoRecurso" AS ENUM ('oftalmologo', 'optometra', 'anestesiologo', 'auxiliar', 'tecnico');

-- CreateEnum
CREATE TYPE "EsquemaPago" AS ENUM ('por_paciente', 'fijo', 'mixto');

-- CreateEnum
CREATE TYPE "Especialidad" AS ENUM ('oftalmologia', 'optometria', 'anestesiologia', 'diagnostico');

-- CreateEnum
CREATE TYPE "EstadoSemana" AS ENUM ('abierta', 'cerrada');

-- CreateEnum
CREATE TYPE "DiaSemana" AS ENUM ('lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo');

-- CreateEnum
CREATE TYPE "EstadoEjecucion" AS ENUM ('completa', 'parcial', 'no_ejecutada');

-- CreateEnum
CREATE TYPE "TipoAusencia" AS ENUM ('enfermedad', 'calamidad', 'academico', 'familiar', 'vacaciones', 'no_presentacion', 'licencia_remunerada', 'licencia_no_remunerada', 'otra');

-- CreateEnum
CREATE TYPE "EstadoAusencia" AS ENUM ('pendiente', 'confirmada', 'rechazada');

-- CreateEnum
CREATE TYPE "CanalNotificacion" AS ENUM ('app', 'email', 'whatsapp');

-- CreateEnum
CREATE TYPE "EstadoAsignacion" AS ENUM ('activa', 'cancelada', 'sin_cobertura');

-- CreateTable
CREATE TABLE "usuarios" (
    "id" TEXT NOT NULL,
    "nombre" VARCHAR(150) NOT NULL,
    "email" VARCHAR(200) NOT NULL,
    "celular" VARCHAR(20),
    "password_hash" VARCHAR(255) NOT NULL,
    "rol" "Rol" NOT NULL,
    "recurso_id" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "ultimo_login" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usuarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usuarios_sedes" (
    "usuario_id" TEXT NOT NULL,
    "sede_id" TEXT NOT NULL,

    CONSTRAINT "usuarios_sedes_pkey" PRIMARY KEY ("usuario_id","sede_id")
);

-- CreateTable
CREATE TABLE "sedes" (
    "id" TEXT NOT NULL,
    "nombre" VARCHAR(150) NOT NULL,
    "ciudad" VARCHAR(100) NOT NULL,
    "direccion" TEXT,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sedes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consultorios" (
    "id" TEXT NOT NULL,
    "sede_id" TEXT NOT NULL,
    "nombre" VARCHAR(100) NOT NULL,
    "especialidad" "Especialidad" NOT NULL,
    "requiere_auxiliar" BOOLEAN NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consultorios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recursos" (
    "id" TEXT NOT NULL,
    "nombre" VARCHAR(150) NOT NULL,
    "tipo" "TipoRecurso" NOT NULL,
    "especialidad" VARCHAR(100),
    "intervalo_minutos" INTEGER,
    "esquema_pago" "EsquemaPago" NOT NULL,
    "horas_max_semana" INTEGER NOT NULL DEFAULT 42,
    "horas_max_dia" INTEGER NOT NULL DEFAULT 10,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "motivo_inactivacion" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recursos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "semanas" (
    "id" TEXT NOT NULL,
    "fecha_inicio" DATE NOT NULL,
    "fecha_fin" DATE NOT NULL,
    "estado" "EstadoSemana" NOT NULL DEFAULT 'abierta',
    "cerrada_por" TEXT,
    "cerrada_en" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "semanas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asignaciones" (
    "id" TEXT NOT NULL,
    "semana_id" TEXT NOT NULL,
    "recurso_id" TEXT NOT NULL,
    "auxiliar_id" TEXT,
    "consultorio_id" TEXT NOT NULL,
    "dia_semana" "DiaSemana" NOT NULL,
    "hora_inicio" VARCHAR(5) NOT NULL,
    "hora_fin" VARCHAR(5) NOT NULL,
    "pacientes_capacidad" INTEGER NOT NULL,
    "es_horas_extras" BOOLEAN NOT NULL DEFAULT false,
    "tiene_horas_nocturnas" BOOLEAN NOT NULL DEFAULT false,
    "es_reemplazo" BOOLEAN NOT NULL DEFAULT false,
    "ausencia_cubierta_id" TEXT,
    "estado" "EstadoAsignacion" NOT NULL DEFAULT 'activa',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asignaciones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ejecucion" (
    "id" TEXT NOT NULL,
    "asignacion_id" TEXT NOT NULL,
    "pacientes_atendidos" INTEGER NOT NULL,
    "estado_jornada" "EstadoEjecucion" NOT NULL DEFAULT 'completa',
    "observaciones" TEXT,
    "registrado_por" TEXT NOT NULL,
    "registrado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bloqueado" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ejecucion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ausencias" (
    "id" TEXT NOT NULL,
    "recurso_id" TEXT NOT NULL,
    "fecha_inicio" DATE NOT NULL,
    "fecha_fin" DATE NOT NULL,
    "es_parcial" BOOLEAN NOT NULL DEFAULT false,
    "hora_inicio_ausencia" VARCHAR(5),
    "hora_fin_ausencia" VARCHAR(5),
    "tipo" "TipoAusencia" NOT NULL,
    "motivo" TEXT,
    "archivo_adjunto" VARCHAR(500),
    "es_programada" BOOLEAN NOT NULL DEFAULT false,
    "anticipacion_dias" INTEGER NOT NULL DEFAULT 0,
    "estado" "EstadoAusencia" NOT NULL DEFAULT 'pendiente',
    "pacientes_impactados" INTEGER,
    "costo_oportunidad" DECIMAL(12,2),
    "costo_personal_inactivo" DECIMAL(12,2),
    "quejas_registradas" INTEGER,
    "accion_tomada" TEXT,
    "impacto_por_dia" JSONB,
    "motivo_rechazo" TEXT,
    "registrado_por_coordinador" BOOLEAN NOT NULL DEFAULT false,
    "reportado_por" TEXT NOT NULL,
    "reportado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmado_por" TEXT,
    "confirmado_en" TIMESTAMP(3),

    CONSTRAINT "ausencias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parametros_costo" (
    "id" TEXT NOT NULL,
    "tipo_consulta" "Especialidad" NOT NULL,
    "costo_cita" DECIMAL(12,2) NOT NULL,
    "costo_reprogramacion" DECIMAL(12,2) NOT NULL,
    "vigente_desde" DATE NOT NULL,
    "configurado_por" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parametros_costo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parametros_sistema" (
    "clave" VARCHAR(100) NOT NULL,
    "valor" JSONB NOT NULL,
    "motivo" TEXT,
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parametros_sistema_pkey" PRIMARY KEY ("clave")
);

-- CreateTable
CREATE TABLE "tareas_backoffice" (
    "id" TEXT NOT NULL,
    "nombre" VARCHAR(150) NOT NULL,
    "descripcion" TEXT,
    "tiempo_estimado_minutos" INTEGER NOT NULL,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "creada_por" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tareas_backoffice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asignaciones_backoffice" (
    "id" TEXT NOT NULL,
    "auxiliar_id" TEXT NOT NULL,
    "sede_id" TEXT NOT NULL,
    "tarea_backoffice_id" TEXT NOT NULL,
    "ausencia_origen_id" TEXT,
    "dia" DATE NOT NULL,
    "hora_inicio" VARCHAR(5) NOT NULL,
    "hora_fin" VARCHAR(5) NOT NULL,
    "asignado_por" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asignaciones_backoffice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ejecucion_backoffice" (
    "id" TEXT NOT NULL,
    "asignacion_backoffice_id" TEXT NOT NULL,
    "tarea_id" TEXT NOT NULL,
    "unidades_completadas" INTEGER NOT NULL,
    "tiempo_real_minutos" INTEGER NOT NULL,
    "observaciones" TEXT,
    "registrado_por" TEXT NOT NULL,
    "registrado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ejecucion_backoffice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "festivos" (
    "fecha" DATE NOT NULL,
    "descripcion" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "festivos_pkey" PRIMARY KEY ("fecha")
);

-- CreateTable
CREATE TABLE "notificaciones" (
    "id" TEXT NOT NULL,
    "usuario_id" TEXT NOT NULL,
    "tipo" VARCHAR(50) NOT NULL,
    "titulo" VARCHAR(200) NOT NULL,
    "mensaje" TEXT NOT NULL,
    "canal" "CanalNotificacion" NOT NULL,
    "leida" BOOLEAN NOT NULL DEFAULT false,
    "enviada" BOOLEAN NOT NULL DEFAULT false,
    "referencia_id" TEXT,
    "creada_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notificaciones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auditoria" (
    "id" TEXT NOT NULL,
    "usuario_id" TEXT NOT NULL,
    "accion" VARCHAR(100) NOT NULL,
    "entidad" VARCHAR(50) NOT NULL,
    "entidad_id" TEXT NOT NULL,
    "valor_anterior" JSONB,
    "valor_nuevo" JSONB,
    "motivo" TEXT,
    "ip_address" VARCHAR(45),
    "creada_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auditoria_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "usuarios_email_key" ON "usuarios"("email");

-- CreateIndex
CREATE UNIQUE INDEX "usuarios_recurso_id_key" ON "usuarios"("recurso_id");

-- CreateIndex
CREATE INDEX "usuarios_rol_idx" ON "usuarios"("rol");

-- CreateIndex
CREATE INDEX "sedes_ciudad_idx" ON "sedes"("ciudad");

-- CreateIndex
CREATE INDEX "sedes_activa_idx" ON "sedes"("activa");

-- CreateIndex
CREATE INDEX "consultorios_sede_id_idx" ON "consultorios"("sede_id");

-- CreateIndex
CREATE INDEX "consultorios_activo_idx" ON "consultorios"("activo");

-- CreateIndex
CREATE INDEX "recursos_tipo_idx" ON "recursos"("tipo");

-- CreateIndex
CREATE INDEX "recursos_activo_idx" ON "recursos"("activo");

-- CreateIndex
CREATE UNIQUE INDEX "semanas_fecha_inicio_key" ON "semanas"("fecha_inicio");

-- CreateIndex
CREATE INDEX "semanas_estado_idx" ON "semanas"("estado");

-- CreateIndex
CREATE INDEX "asignaciones_recurso_id_dia_semana_hora_inicio_idx" ON "asignaciones"("recurso_id", "dia_semana", "hora_inicio");

-- CreateIndex
CREATE INDEX "asignaciones_auxiliar_id_dia_semana_hora_inicio_idx" ON "asignaciones"("auxiliar_id", "dia_semana", "hora_inicio");

-- CreateIndex
CREATE INDEX "asignaciones_consultorio_id_dia_semana_idx" ON "asignaciones"("consultorio_id", "dia_semana");

-- CreateIndex
CREATE INDEX "asignaciones_semana_id_idx" ON "asignaciones"("semana_id");

-- CreateIndex
CREATE UNIQUE INDEX "ejecucion_asignacion_id_key" ON "ejecucion"("asignacion_id");

-- CreateIndex
CREATE INDEX "ejecucion_registrado_en_idx" ON "ejecucion"("registrado_en");

-- CreateIndex
CREATE INDEX "ausencias_recurso_id_idx" ON "ausencias"("recurso_id");

-- CreateIndex
CREATE INDEX "ausencias_estado_idx" ON "ausencias"("estado");

-- CreateIndex
CREATE INDEX "ausencias_fecha_inicio_idx" ON "ausencias"("fecha_inicio");

-- CreateIndex
CREATE INDEX "parametros_costo_tipo_consulta_vigente_desde_idx" ON "parametros_costo"("tipo_consulta", "vigente_desde");

-- CreateIndex
CREATE INDEX "tareas_backoffice_activa_idx" ON "tareas_backoffice"("activa");

-- CreateIndex
CREATE INDEX "asignaciones_backoffice_auxiliar_id_dia_idx" ON "asignaciones_backoffice"("auxiliar_id", "dia");

-- CreateIndex
CREATE INDEX "ejecucion_backoffice_asignacion_backoffice_id_idx" ON "ejecucion_backoffice"("asignacion_backoffice_id");

-- CreateIndex
CREATE INDEX "notificaciones_usuario_id_leida_idx" ON "notificaciones"("usuario_id", "leida");

-- CreateIndex
CREATE INDEX "auditoria_usuario_id_idx" ON "auditoria"("usuario_id");

-- CreateIndex
CREATE INDEX "auditoria_accion_idx" ON "auditoria"("accion");

-- CreateIndex
CREATE INDEX "auditoria_entidad_entidad_id_idx" ON "auditoria"("entidad", "entidad_id");

-- CreateIndex
CREATE INDEX "auditoria_creada_en_idx" ON "auditoria"("creada_en");

-- AddForeignKey
ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_recurso_id_fkey" FOREIGN KEY ("recurso_id") REFERENCES "recursos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usuarios_sedes" ADD CONSTRAINT "usuarios_sedes_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usuarios_sedes" ADD CONSTRAINT "usuarios_sedes_sede_id_fkey" FOREIGN KEY ("sede_id") REFERENCES "sedes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultorios" ADD CONSTRAINT "consultorios_sede_id_fkey" FOREIGN KEY ("sede_id") REFERENCES "sedes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asignaciones" ADD CONSTRAINT "asignaciones_semana_id_fkey" FOREIGN KEY ("semana_id") REFERENCES "semanas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asignaciones" ADD CONSTRAINT "asignaciones_recurso_id_fkey" FOREIGN KEY ("recurso_id") REFERENCES "recursos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asignaciones" ADD CONSTRAINT "asignaciones_auxiliar_id_fkey" FOREIGN KEY ("auxiliar_id") REFERENCES "recursos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asignaciones" ADD CONSTRAINT "asignaciones_consultorio_id_fkey" FOREIGN KEY ("consultorio_id") REFERENCES "consultorios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asignaciones" ADD CONSTRAINT "asignaciones_ausencia_cubierta_id_fkey" FOREIGN KEY ("ausencia_cubierta_id") REFERENCES "ausencias"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ejecucion" ADD CONSTRAINT "ejecucion_asignacion_id_fkey" FOREIGN KEY ("asignacion_id") REFERENCES "asignaciones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ausencias" ADD CONSTRAINT "ausencias_recurso_id_fkey" FOREIGN KEY ("recurso_id") REFERENCES "recursos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asignaciones_backoffice" ADD CONSTRAINT "asignaciones_backoffice_auxiliar_id_fkey" FOREIGN KEY ("auxiliar_id") REFERENCES "recursos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asignaciones_backoffice" ADD CONSTRAINT "asignaciones_backoffice_sede_id_fkey" FOREIGN KEY ("sede_id") REFERENCES "sedes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asignaciones_backoffice" ADD CONSTRAINT "asignaciones_backoffice_tarea_backoffice_id_fkey" FOREIGN KEY ("tarea_backoffice_id") REFERENCES "tareas_backoffice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asignaciones_backoffice" ADD CONSTRAINT "asignaciones_backoffice_ausencia_origen_id_fkey" FOREIGN KEY ("ausencia_origen_id") REFERENCES "ausencias"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ejecucion_backoffice" ADD CONSTRAINT "ejecucion_backoffice_asignacion_backoffice_id_fkey" FOREIGN KEY ("asignacion_backoffice_id") REFERENCES "asignaciones_backoffice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notificaciones" ADD CONSTRAINT "notificaciones_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auditoria" ADD CONSTRAINT "auditoria_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
