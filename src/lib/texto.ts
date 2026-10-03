/** Utilidades puras de normalización y parseo de los documentos del paquete. */

/** "11.400.000" → 11400000 · "1.234,50" → 1234.5 · "COP 95.000" → 95000 */
export const parseMonto = (texto: string): number | null => {
  const limpio = texto.replace(/[^\d.,-]/g, "")
  if (!/\d/.test(limpio)) return null
  const normalizado = limpio.replace(/\./g, "").replace(",", ".")
  const n = Number(normalizado)
  return Number.isFinite(n) ? n : null
}

/** "900.555.111-2" → "900555111" (sin puntos ni dígito de verificación). */
export const normalizarNit = (nit: string): string => nit.split("-")[0]!.replace(/\D/g, "")

const SUFIJOS_SOCIETARIOS = /(sas|sa|ltda|sca|scs)$/

/** "TecnoSuministros S.A.S." → "tecnosuministros" para comparar nombres de proveedor. */
export const normalizarNombre = (nombre: string): string =>
  nombre
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(SUFIJOS_SOCIETARIOS, "")

/** Busca "Etiqueta: valor" (primera coincidencia, sin distinguir mayúsculas). */
export const campo = (texto: string, etiqueta: RegExp): string | null => {
  const m = texto.match(new RegExp(`^\\s*${etiqueta.source}\\s*:\\s*(.+)$`, "im"))
  return m?.[1]?.trim() ?? null
}

/** Fecha local tal como viene escrita (AAAA-MM-DD), sin convertir zona horaria. */
export const soloFecha = (iso: string): string => iso.slice(0, 10)

export const sumarDias = (fechaIso: string, dias: number): string => {
  const d = new Date(`${soloFecha(fechaIso)}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + dias)
  return d.toISOString().slice(0, 10)
}

/** El texto de aprobación contiene "Aprobado" y no está negado ("no aprobado"). */
export const contieneAprobado = (cuerpo: string): boolean =>
  /\baprobad[oa]\b/i.test(cuerpo) && !/\bno\s+(est[aá]\s+)?aprobad[oa]\b/i.test(cuerpo)

export const formatoMoneda = (valor: number, moneda: string): string =>
  `${moneda} ${valor.toLocaleString("es-CO", { maximumFractionDigits: 2 })}`

/** Recorta a `max` caracteres sin cortar palabras cuando es posible (límite SAP de texto breve). */
export const recortar = (texto: string, max: number): string => {
  const limpio = texto.replace(/\s+/g, " ").trim()
  if (limpio.length <= max) return limpio
  const corte = limpio.slice(0, max)
  const espacio = corte.lastIndexOf(" ")
  const recorte = espacio > max * 0.6 ? corte.slice(0, espacio) : corte
  return recorte.replace(/[\s,;:.-]+$/, "").replace(/\s+(de|del|la|el|los|las|para|con|y|a|en|por)$/i, "")
}
