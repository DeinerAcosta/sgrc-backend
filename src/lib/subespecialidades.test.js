import { describe, it, expect } from 'vitest'
import {
  claveSubespecialidad, enCatalogo, normalizarAntigua, resolverSubespecialidad, exigeSubespecialidad, DE_OTRO_TIPO,
} from './subespecialidades.js'

// Oct-2026 · PROYECTOS-3800 · subespecialidad obligatoria y de catálogo.
const OFT = ['Oftalmología general', 'Segmento anterior', 'Córnea y refractiva', 'Glaucoma', 'Retina y vítreo', 'Oculoplastia', 'Oftalmopediatría', 'Neuro-oftalmología']
const OTO = ['Otorrinolaringología general', 'Otología', 'Rinología', 'Laringología']
// BD simulada: solo lo que usa nombresDelCatalogo.
const db = { subspecialty: { findMany: async ({ where }) => (where.resourceType === 'oftalmologo' ? OFT : where.resourceType === 'otorrino' ? OTO : []).map((name) => ({ name })) } }

describe('claveSubespecialidad', () => {
  it('ignora tildes, mayúsculas y espacios de más', () => {
    expect(claveSubespecialidad('OFTALMOLOGIA  GENERAL')).toBe(claveSubespecialidad('Oftalmología general'))
    expect(claveSubespecialidad('  RETINA Y VÍTREO ')).toBe('retina y vitreo')
  })
})

describe('enCatalogo', () => {
  it('devuelve el nombre tal como está en el catálogo', () => {
    expect(enCatalogo(OFT, 'glaucoma')).toBe('Glaucoma')
    expect(enCatalogo(OFT, 'CORNEA Y REFRACTIVA')).toBe('Córnea y refractiva')
  })
  it('un texto que no está no se acepta', () => {
    expect(enCatalogo(OFT, 'Segamento')).toBeNull()
    expect(enCatalogo(OFT, '')).toBeNull()
  })
})

describe('normalizarAntigua — los valores reales de producción', () => {
  const casos = [
    ['OFTALMOLOGIA  GENERAL', 'Oftalmología general'], ['GENERAL', 'Oftalmología general'],
    ['SEGMENTO ANTERIOR', 'Segmento anterior'], ['Segmento', 'Segmento anterior'], ['Segamento', 'Segmento anterior'],
    ['SEGMENTO ANTERIOR Y CÓRNEA', 'Segmento anterior'], ['cornea', 'Córnea y refractiva'], ['CÓRNEA Y REFRACTIVA', 'Córnea y refractiva'],
    ['GLAUCOMA', 'Glaucoma'], ['Retina', 'Retina y vítreo'], ['RETINA Y VÍTREO', 'Retina y vítreo'],
    ['OCULOPLASTIA', 'Oculoplastia'], ['OCULOPASTIA', 'Oculoplastia'], ['PLASTIA OCULAR', 'Oculoplastia'],
    ['pediatria', 'Oftalmopediatría'], ['pediatra', 'Oftalmopediatría'], ['OFTALMOPEDIATRIA', 'Oftalmopediatría'],
    ['NEUROOFTALMOLOGIA', 'Neuro-oftalmología'],
  ]
  it.each(casos)('oftalmólogo "%s" → %s', (viejo, nuevo) => {
    expect(normalizarAntigua('oftalmologo', viejo, OFT)).toBe(nuevo)
  })
  it('otorrino "OTORRINOLARINGOLOGIA" → Otorrinolaringología general', () => {
    expect(normalizarAntigua('otorrino', 'OTORRINOLARINGOLOGIA', OTO)).toBe('Otorrinolaringología general')
  })
  it('un oftalmólogo con subespecialidad de otorrino NO se corrige solo', () => {
    expect(normalizarAntigua('oftalmologo', 'OTORRINOLARINGOLOGIA', OFT)).toBeNull()
    expect(DE_OTRO_TIPO.oftalmologo).toContain(claveSubespecialidad('otologia'))
  })
})

describe('resolverSubespecialidad', () => {
  it('solo la exigen oftalmólogo y otorrino', () => {
    expect(exigeSubespecialidad('oftalmologo')).toBe(true)
    expect(exigeSubespecialidad('otorrino')).toBe(true)
    expect(exigeSubespecialidad('optometra')).toBe(false)
  })
  it('sin subespecialidad, un oftalmólogo no se crea', async () => {
    await expect(resolverSubespecialidad(db, 'oftalmologo', '')).rejects.toThrow(/obligatoria/)
    await expect(resolverSubespecialidad(db, 'otorrino', null)).rejects.toThrow(/obligatoria/)
  })
  it('una que no está en el catálogo se rechaza', async () => {
    await expect(resolverSubespecialidad(db, 'oftalmologo', 'Segamento')).rejects.toThrow(/catálogo/)
  })
  it('una del catálogo se guarda con su nombre exacto', async () => {
    await expect(resolverSubespecialidad(db, 'oftalmologo', 'retina y vitreo')).resolves.toBe('Retina y vítreo')
  })
  it('otros tipos no la exigen y guardan el texto como antes', async () => {
    await expect(resolverSubespecialidad(db, 'optometra', '')).resolves.toBeNull()
    await expect(resolverSubespecialidad(db, 'optometra', ' Baja visión ')).resolves.toBe('Baja visión')
  })
  it('obligatoria:false deja pasar el vacío (desactivar sin ponérsela)', async () => {
    await expect(resolverSubespecialidad(db, 'oftalmologo', '', { obligatoria: false })).resolves.toBeNull()
  })
})
