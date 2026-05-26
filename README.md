# SGRC Backend

API REST del Sistema de Gestión de Recursos Clínicos.

## Stack

- **Node.js 20** + **Express 4** (ESM)
- **MySQL 8** + **Prisma 6**
- **JWT** (8h) + **Refresh token** (7d) + **bcrypt**
- **Zod** para validación de inputs
- **Helmet** + **express-rate-limit** para seguridad

## Estructura

```
backend/
├── src/
│   ├── index.js              entry point Express
│   ├── routes/index.js       todas las rutas
│   ├── controllers/          lógica de petición/respuesta
│   ├── services/             lógica de negocio (asignacionService con las 6 validaciones)
│   ├── middleware/           auth, error, audit
│   ├── lib/                  prisma, jwt, errors
│   └── schemas/              validación Zod
└── prisma/
    ├── schema.prisma         15 tablas
    └── seed.js               datos iniciales
```

## Setup (primera vez)

### 1. Instalar MySQL 8+

**Opción A — Instalador oficial (recomendado en Windows):**
1. Descargar de https://dev.mysql.com/downloads/installer/
2. Ejecutar el instalador. Anotar la **contraseña del usuario `root`** que pongas.
3. Puerto: dejar `3306`.

**Opción B — Docker:**
```powershell
docker run --name sgrc-mysql -e MYSQL_ROOT_PASSWORD=Admin123 -p 3306:3306 -d mysql:8
```

### 2. Crear la base de datos
Desde MySQL Workbench / DBeaver (conexión MySQL a `localhost:3306` con usuario `root`) o desde la consola `mysql`:
```sql
CREATE DATABASE sgrc CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

### 3. Instalar dependencias
```powershell
cd "C:\Users\Hector\Documents\Proyecto recursos\backend"
npm install
```

### 4. Configurar variables de entorno
Editar `backend/.env` y reemplazar `TU_PASSWORD` por la contraseña real del usuario `root`:
```
DATABASE_URL="mysql://root:TU_PASSWORD@localhost:3306/sgrc"
```

### 5. Migrar y sembrar
```powershell
npm run prisma:migrate -- --name init
npm run prisma:seed
```

### 6. Levantar el servidor
```powershell
npm run dev
```

El backend escucha en `http://localhost:3001/api`. Health check: `http://localhost:3001/health`.

## Conectar el frontend al backend real

1. En `frontend/.env` poner `VITE_DEMO_MODE=false`
2. Reiniciar `npm run dev` del frontend
3. Iniciar sesión con uno de los usuarios sembrados (password: **Admin123**):
   - `angela.sarmiento@cofca.co` — recurso
   - `maria.lopez@cofca.co` — coordinador
   - `carlos.reyes@cofca.co` — directivo
   - `desarrollo@cofca.com` — supervisor

## Endpoints principales

Ver `src/routes/index.js`. Todos los endpoints requieren `Authorization: Bearer <token>` excepto `/auth/login`, `/auth/refresh`, `/auth/forgot-password` y `/health`.

## Reglas de negocio implementadas en backend

- **6 validaciones críticas del Diagrama 3** en `src/services/asignacionService.js`:
  1. Semana abierta o supervisor (HTTP 403)
  2. Recurso libre en franja (HTTP 409)
  3. Ciudad única por día (HTTP 409)
  4. Auxiliar libre (HTTP 409)
  5. ≤10h diarias (HTTP 400)
  6. >42h semanales → flag `es_horas_extras` (no bloquea)
- **RN-16 condición de carrera**: `SELECT ... FOR UPDATE` sobre la fila del recurso + aislamiento `READ COMMITTED` (serializa sin ventana de carrera; InnoDB libera el lock al commit)
- **RN-01 anticipación de 3 días** para crear semana
- **RN-11 cálculo de capacidad** (FLOOR con almuerzo si jornada ≥ 6h)
- **RN-17 eliminación con ejecución**: marca como cancelada en lugar de eliminar
- **RN-18 impacto día a día** al confirmar ausencia
- **RN-19 ausencia parcial**: impacto proporcional al tiempo
- **RN-20 motivo obligatorio** al rechazar ausencia
- **RN-24 liberación automática** de auxiliar al confirmar ausencia de médico
- **RN-34 trazabilidad** de exportaciones e cambios críticos en `auditoria`
- **HU-S-01 motivo obligatorio** al supervisor modificar semana cerrada

## Despliegue en producción (nube)

El backend se despliega como un servicio Node independiente (Railway, Render, Fly.io o un VPS con Docker), con una base de datos **MySQL 8 gestionada**.

### 1. Variables de entorno (en el panel del proveedor, NO en un archivo)
```
DATABASE_URL=mysql://USER:PASS@HOST:3306/sgrc?connection_limit=20&pool_timeout=20
JWT_SECRET=<cadena aleatoria de 32+ caracteres>
REFRESH_SECRET=<otra cadena aleatoria distinta>
JWT_EXPIRES_IN=8h
REFRESH_EXPIRES_IN=7d
NODE_ENV=production
PORT=3001
FRONTEND_ORIGIN=https://TU-FRONTEND.vercel.app
RATE_LIMIT_LOGIN=5
RATE_LIMIT_GLOBAL=100
```
> Genera los secretos con: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
> `connection_limit` en la URL es clave para soportar muchos usuarios concurrentes (ver más abajo).

### 2. Comandos de build y arranque
```
npm install
npx prisma generate
npx prisma migrate deploy   # aplica migraciones (NO usar "migrate dev" en prod)
npm start                   # node src/index.js
```
Para cargar los datos de demostración una sola vez: `npm run prisma:seed`.

### 3. Con Docker (VPS)
El repo incluye `Dockerfile`. Construir y correr:
```
docker build -t sgrc-backend .
docker run -p 3001:3001 --env-file .env sgrc-backend
```

### 4. CORS
`FRONTEND_ORIGIN` debe contener el dominio exacto del frontend (Vercel). Acepta varios separados por coma.

## Notas de escalabilidad (100+ usuarios concurrentes)

El stack aguanta 100 usuarios concurrentes sin colapsar. Para que sea sólido bajo carga:
- **Pool de conexiones**: fija `connection_limit` en `DATABASE_URL` (arriba). Si crece mucho, añade **ProxySQL** delante de MySQL.
- **Varias instancias**: Node usa 1 CPU por proceso → corre 2+ réplicas detrás del balanceador del proveedor (o PM2 en cluster en un VPS).
- **Índices**: ya están definidos en `schema.prisma` para todas las tablas calientes.
- **Informes**: el dashboard y el comparativo ya están cacheados en memoria unos segundos (anti-stampede) para absorber picos de concurrencia.

## Funcionalidad ya implementada

Email (Nodemailer) y WhatsApp con modo "log" cuando no hay credenciales, jobs cron
(alerta de ociosos, RN-25), exportación real PDF/Excel (PDFKit + ExcelJS) y reset de
contraseña por token con vigencia de 1 hora.
