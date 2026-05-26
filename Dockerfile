# SGRC Backend — Node 20 alpine
# Multi-stage: instalación de deps en una capa cacheable + imagen final ligera.

# ---------- Stage 1: dependencias ----------
FROM node:20-alpine AS deps

WORKDIR /app

# Prisma + bcrypt necesitan estas libs en alpine
RUN apk add --no-cache openssl libc6-compat

COPY package*.json ./
COPY prisma ./prisma

# `npm ci` usa package-lock.json y es reproducible (vs npm install).
RUN npm ci --omit=dev

# Generar Prisma client después de copiar el schema
RUN npx prisma generate

# ---------- Stage 2: imagen runtime ----------
FROM node:20-alpine AS runtime

WORKDIR /app

RUN apk add --no-cache openssl libc6-compat tini

# Usuario no-root (mejor práctica de seguridad)
RUN addgroup -g 1001 -S nodejs && adduser -S sgrc -u 1001

COPY --from=deps --chown=sgrc:nodejs /app/node_modules ./node_modules
COPY --from=deps --chown=sgrc:nodejs /app/prisma ./prisma
COPY --chown=sgrc:nodejs package*.json ./
COPY --chown=sgrc:nodejs src ./src

USER sgrc

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

# tini = init mínimo que reenvía señales correctamente (SIGTERM en docker stop)
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
