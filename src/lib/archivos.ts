import { mkdir, readFile, writeFile, appendFile, access } from "node:fs/promises"
import { dirname, join, resolve, sep } from "node:path"
import type { Resultado } from "../tools/tipos.ts"

export const RUTA_SOLICITUDES = "fixtures/reto-03/solicitudes"
export const RUTA_MAESTROS = "fixtures/reto-03/maestros"

/** Solo nombres de carpeta simples: evita salir de fixtures/ con "../". */
export const casoValido = (caso: string): boolean => /^[A-Za-z0-9_-]{1,64}$/.test(caso)

/** Resuelve una ruta relativa a la raíz y garantiza que no escape de ella. */
export const rutaSegura = (raiz: string, ...partes: string[]): string => {
  const base = resolve(raiz)
  const destino = resolve(base, ...partes)
  if (destino !== base && !destino.startsWith(base + sep)) throw new Error(`ruta fuera del proyecto: ${partes.join("/")}`)
  return destino
}

export const existe = async (ruta: string): Promise<boolean> =>
  access(ruta).then(
    () => true,
    () => false,
  )

export const leerTexto = async (ruta: string): Promise<string | null> =>
  (await existe(ruta)) ? readFile(ruta, "utf8") : null

/** Lee y parsea JSON. Distingue "no existe" (null) de "malformado" (error). */
export const leerJson = async (ruta: string, nombre: string): Promise<Resultado<unknown> | null> => {
  const texto = await leerTexto(ruta)
  if (texto === null) return null
  try {
    return { ok: true, data: JSON.parse(texto) }
  } catch (e) {
    return { ok: false, error: `${nombre} no es JSON válido: ${(e as Error).message}` }
  }
}

export const escribir = async (ruta: string, contenido: string | Uint8Array): Promise<void> => {
  await mkdir(dirname(ruta), { recursive: true })
  await writeFile(ruta, contenido)
}

export const anexar = async (ruta: string, linea: string): Promise<void> => {
  await mkdir(dirname(ruta), { recursive: true })
  await appendFile(ruta, linea)
}

export const rutaOut = (directorio: string, ...partes: string[]): string => rutaSegura(directorio, join("out", ...partes))
