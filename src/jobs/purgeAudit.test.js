import { describe, it, expect, vi } from 'vitest'
import { jobPurgarAuditoria, mesesDeRetencion, fechaCorte, RETENCION_MESES_POR_DEFECTO } from './purgeAudit.js'
import { jobsHabilitados } from './index.js'

describe('mesesDeRetencion', () => {
  it('usa 24 meses si no se configura nada', () => {
    expect(mesesDeRetencion({})).toBe(RETENCION_MESES_POR_DEFECTO)
    expect(RETENCION_MESES_POR_DEFECTO).toBe(24)
  })

  it('respeta el valor configurado', () => {
    expect(mesesDeRetencion({ AUDITORIA_RETENCION_MESES: '6' })).toBe(6)
    expect(mesesDeRetencion({ AUDITORIA_RETENCION_MESES: '0' })).toBe(0)
  })

  it('ignora valores absurdos y vuelve al defecto', () => {
    expect(mesesDeRetencion({ AUDITORIA_RETENCION_MESES: 'muchos' })).toBe(24)
    expect(mesesDeRetencion({ AUDITORIA_RETENCION_MESES: '-3' })).toBe(24)
    expect(mesesDeRetencion({ AUDITORIA_RETENCION_MESES: '' })).toBe(24)
  })
})

describe('fechaCorte', () => {
  it('retrocede los meses pedidos', () => {
    const corte = fechaCorte(24, new Date('2026-09-02T00:00:00Z'))
    expect(corte.toISOString().slice(0, 10)).toBe('2024-09-02')
  })

  it('cruza bien el cambio de año', () => {
    const corte = fechaCorte(3, new Date('2026-01-15T00:00:00Z'))
    expect(corte.toISOString().slice(0, 10)).toBe('2025-10-15')
  })
})

/** Cliente Prisma simulado con `n` filas antiguas, que responde por lotes. */
function clienteConFilas(n) {
  let restantes = n
  return {
    borradas: 0,
    lotes: 0,
    auditEntry: {
      findMany: vi.fn(async ({ take }) => {
        const cuantas = Math.min(take, restantes)
        return Array.from({ length: cuantas }, (_, i) => ({ id: `a${restantes - i}` }))
      }),
      deleteMany: vi.fn(async ({ where }) => {
        const count = where.id.in.length
        restantes -= count
        return { count }
      }),
    },
  }
}

describe('jobPurgarAuditoria', () => {
  it('no borra nada con retención indefinida (0)', async () => {
    vi.stubEnv('AUDITORIA_RETENCION_MESES', '0')
    const cliente = clienteConFilas(5000)
    const r = await jobPurgarAuditoria(cliente)
    expect(r.purgadas).toBe(0)
    expect(cliente.auditEntry.findMany).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })

  it('borra por lotes de 1000 en lugar de un DELETE gigante', async () => {
    const cliente = clienteConFilas(2500)
    const r = await jobPurgarAuditoria(cliente)

    expect(r.purgadas).toBe(2500)
    // 1000 + 1000 + 500 → tres vueltas, y para al ver un lote incompleto
    expect(cliente.auditEntry.deleteMany).toHaveBeenCalledTimes(3)
    for (const llamada of cliente.auditEntry.deleteMany.mock.calls) {
      expect(llamada[0].where.id.in.length).toBeLessThanOrEqual(1000)
    }
  })

  it('para en seco si no hay nada que purgar', async () => {
    const cliente = clienteConFilas(0)
    const r = await jobPurgarAuditoria(cliente)
    expect(r.purgadas).toBe(0)
    expect(cliente.auditEntry.deleteMany).not.toHaveBeenCalled()
  })

  it('filtra por fecha de creación anterior al corte', async () => {
    const cliente = clienteConFilas(10)
    await jobPurgarAuditoria(cliente)
    const where = cliente.auditEntry.findMany.mock.calls[0][0].where
    expect(where.createdAt.lt).toBeInstanceOf(Date)
    expect(where.createdAt.lt.getTime()).toBeLessThan(Date.now())
  })

  it('informa del corte usado', async () => {
    const r = await jobPurgarAuditoria(clienteConFilas(1))
    expect(r.meses).toBe(24)
    expect(r.corte).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('jobsHabilitados — evitar cron duplicados al escalar', () => {
  it('activos por defecto (despliegue de una sola instancia)', () => {
    expect(jobsHabilitados({})).toBe(true)
  })

  it('se apagan con JOBS_ENABLED=false', () => {
    expect(jobsHabilitados({ JOBS_ENABLED: 'false' })).toBe(false)
    expect(jobsHabilitados({ JOBS_ENABLED: 'FALSE' })).toBe(false)
  })

  it('cualquier otro valor los deja activos', () => {
    expect(jobsHabilitados({ JOBS_ENABLED: 'true' })).toBe(true)
    expect(jobsHabilitados({ JOBS_ENABLED: '1' })).toBe(true)
  })
})
