import jwt from 'jsonwebtoken'

export function signAccessToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN ?? '8h',
  })
}

export function signRefreshToken(payload) {
  return jwt.sign(payload, process.env.REFRESH_SECRET, {
    expiresIn: process.env.REFRESH_EXPIRES_IN ?? '7d',
  })
}

export function verifyAccessToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET)
}

export function verifyRefreshToken(token) {
  return jwt.verify(token, process.env.REFRESH_SECRET)
}
