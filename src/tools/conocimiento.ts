/** Acceso del agente al conocimiento del proceso (src/knowledge/). El modelo la ve como `conocimiento_consultar`. */
import { z } from "zod"
import { leerTexto, rutaSegura } from "../lib/archivos.ts"
import { fallo, herramienta, ok } from "./tipos.ts"

export const RUTA_CONOCIMIENTO = "src/knowledge/ordenes-compra.md"

/** Divide el Markdown en secciones `## Título`. */
export const secciones = (md: string): { titulo: string; contenido: string }[] =>
  md
    .split(/^## /m)
    .slice(1)
    .map((bloque) => {
      const [titulo = "", ...resto] = bloque.split("\n")
      return { titulo: titulo.trim(), contenido: resto.join("\n").trim() }
    })

const normalizar = (t: string): string => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()

export const consultar = herramienta({
  description:
    "Consulta el conocimiento del proceso de órdenes de compra (reglas RC1–RC10, políticas, glosario SAP, acciones sugeridas); sin tema devuelve el índice de secciones.",
  args: {
    tema: z.string().optional().describe('Palabra clave o título de sección, p. ej. "RC5", "retroactiva", "unidad"'),
  },
  execute: async ({ tema }, ctx) => {
    const md = await leerTexto(rutaSegura(ctx.directory, RUTA_CONOCIMIENTO)).catch(() => null)
    if (md === null) return fallo("No se encontró la base de conocimiento.")
    const todas = secciones(md)
    if (!tema) return ok({ secciones: todas.map((s) => s.titulo) })
    const clave = normalizar(tema)
    const encontradas = todas.filter((s) => normalizar(`${s.titulo}\n${s.contenido}`).includes(clave))
    return encontradas.length
      ? ok({ tema, secciones: encontradas })
      : ok({ tema, secciones: [], indice: todas.map((s) => s.titulo), nota: "Sin coincidencias; consulta por un título del índice." })
  },
})
