/**
 * Registro de herramientas: cada export de cada módulo se publica como `<archivo>_<export>`.
 * El backend valida los argumentos con zod antes de ejecutar y nunca deja escapar excepciones.
 */
import { z } from "zod"
import * as conocimiento from "./conocimiento.ts"
import * as oc from "./oc.ts"
import type { ContextoHerramienta, Herramienta } from "./tipos.ts"

export type HerramientaRegistrada = {
  nombre: string
  descripcion: string
  esquema: Record<string, unknown>
  ejecutar(entrada: unknown, ctx: ContextoHerramienta): Promise<string>
}

const MODULOS = { oc, conocimiento } as const

const esHerramienta = (x: unknown): x is Herramienta<z.ZodRawShape> =>
  typeof x === "object" && x !== null && "description" in x && "args" in x && "execute" in x

const registrar = (nombre: string, h: Herramienta<z.ZodRawShape>): HerramientaRegistrada => {
  const esquemaZod = z.object(h.args)
  const { $schema: _omitido, ...esquema } = z.toJSONSchema(esquemaZod, { io: "input", unrepresentable: "any" })
  return {
    nombre,
    descripcion: h.description,
    esquema,
    async ejecutar(entrada, ctx) {
      const r = esquemaZod.safeParse(entrada)
      if (!r.success) {
        const detalle = r.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ")
        return JSON.stringify({ ok: false, error: `Argumentos inválidos para ${nombre}: ${detalle}` })
      }
      try {
        return await h.execute(r.data, ctx)
      } catch (e) {
        return JSON.stringify({ ok: false, error: `Error inesperado en ${nombre}: ${(e as Error).message}` })
      }
    },
  }
}

export const herramientas: HerramientaRegistrada[] = Object.entries(MODULOS).flatMap(([archivo, modulo]) =>
  Object.entries(modulo)
    .filter((par): par is [string, Herramienta<z.ZodRawShape>] => esHerramienta(par[1]))
    .map(([exportado, h]) => registrar(`${archivo}_${exportado}`, h)),
)

export const buscarHerramienta = (nombre: string): HerramientaRegistrada | undefined =>
  herramientas.find((h) => h.nombre === nombre)
