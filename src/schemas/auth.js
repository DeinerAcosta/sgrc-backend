import { z } from 'zod'

export const loginSchema = z.object({
  email: z.string().email('Correo no válido'),
  password: z.string().min(1, 'Contraseña requerida'),
})

export const refreshSchema = z.object({
  refreshToken: z.string().min(10),
})

export const forgotPasswordSchema = z.object({
  email: z.string().email('Correo no válido'),
})

export const resetPasswordSchema = z.object({
  token: z.string().min(20, 'Token inválido'),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
})
