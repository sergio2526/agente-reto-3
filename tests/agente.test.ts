import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CicloAgente } from "../src/agent/ciclo.ts"
import { esConfirmacion } from "../src/agent/confirmacion.ts"
import type { Sesion } from "../src/agent/sesiones.ts"
import type { Mensaje, ProveedorLLM, Respuesta } from "../src/llm/adapter.ts"
import { derivarUnidad } from "../src/lib/payload.ts"
import { normalizarNombre, parseMonto, recortar } from "../src/lib/texto.ts"
import { herramientas } from "../src/tools/index.ts"
import * as oc from "../src/tools/oc.ts"
import type { OrdenCompra, Paquete, Validacion } from "../src/tools/tipos.ts"

// Cada prueba corre sobre una copia temporal del proyecto: fixtures intactos y out/ aislado.
let dir = ""
const ctx = () => ({ directory: dir, sessionId: "test" })
const SOLICITUDES = "fixtures/reto-03/solicitudes"

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "oc-test-"))
  await cp("fixtures", join(dir, "fixtures"), { recursive: true })
  await cp("src/knowledge", join(dir, "src/knowledge"), { recursive: true })
})
afterAll(() => rm(dir, { recursive: true, force: true }))

type Salida<T> = { ok: true; data: T } | { ok: false; error: string; [k: string]: unknown }
const parse = <T>(s: string) => JSON.parse(s) as Salida<T>
const datos = <T>(s: string): T => {
  const r = parse<T>(s)
  if (!r.ok) throw new Error(r.error)
  return r.data
}

const paqueteDe = async (caso: string) => datos<Paquete>(await oc.leer_paquete.execute({ caso }, ctx()))
const validacionDe = async (caso: string) => datos<Validacion>(await oc.validar.execute({ caso, paquete: await paqueteDe(caso) }, ctx()))
const payloadDe = async (caso: string) => {
  const v = await validacionDe(caso)
  return datos<{ payload: OrdenCompra }>(await oc.construir_payload.execute({ caso, paquete: await paqueteDe(caso), derivados: v.derivados }, ctx())).payload
}

describe("reglas de control sobre los 6 casos", () => {
  const esperado: Record<string, { apta: boolean; bloqueos: string[]; confirmaciones: string[]; retroactiva: boolean }> = {
    "sol-001": { apta: true, bloqueos: [], confirmaciones: [], retroactiva: false },
    "sol-002": { apta: false, bloqueos: ["RC1"], confirmaciones: [], retroactiva: false },
    "sol-003": { apta: false, bloqueos: ["RC2"], confirmaciones: [], retroactiva: false },
    "sol-004": { apta: true, bloqueos: [], confirmaciones: ["RC5"], retroactiva: false },
    "sol-005": { apta: true, bloqueos: [], confirmaciones: ["RC8"], retroactiva: true },
    "sol-006": { apta: true, bloqueos: [], confirmaciones: ["RC6"], retroactiva: false },
  }
  for (const [caso, e] of Object.entries(esperado))
    test(caso, async () => {
      const v = await validacionDe(caso)
      expect({
        apta: v.apta,
        bloqueos: v.bloqueos.map((b) => b.codigo),
        confirmaciones: v.confirmaciones.map((c) => c.codigo),
        retroactiva: v.retroactiva,
      }).toEqual(e)
    })

  test("sol-004 informa ambos valores en la confirmación", async () => {
    const rc5 = (await validacionDe("sol-004")).confirmaciones[0]!
    expect(rc5.valores).toMatchObject({ solicitud: 25_000_000, cotizacion: 26_500_000 })
  })

  test("sol-006 deriva IVA y condiciones de pago del proveedor", async () => {
    expect((await validacionDe("sol-006")).derivados).toEqual({
      indicador_iva: { valor: "C1", fuente: "maestro.proveedores" },
      condiciones_pago: { valor: "Z030", fuente: "maestro.proveedores" },
    })
  })
})

describe("creación de OC", () => {
  test("sol-001 se crea sin intervención y es idempotente", async () => {
    const payload = await payloadDe("sol-001")
    const a = datos<{ numero_oc: string; idempotente: boolean }>(await oc.crear.execute({ caso: "sol-001", payload }, ctx()))
    const b = datos<{ numero_oc: string; idempotente: boolean }>(await oc.crear.execute({ caso: "sol-001", payload }, ctx()))
    expect(a).toMatchObject({ numero_oc: "4500000001", idempotente: false })
    expect(b).toMatchObject({ numero_oc: "4500000001", idempotente: true })
    const lineas = (await readFile(join(dir, "out/sap/ordenes.jsonl"), "utf8")).trim().split("\n")
    expect(lineas).toHaveLength(1)
  })

  test("sol-004 sin confirmación queda pendiente; con confirmación se crea", async () => {
    const payload = await payloadDe("sol-004")
    const pendiente = parse(await oc.crear.execute({ caso: "sol-004", payload }, ctx()))
    expect(pendiente).toMatchObject({ ok: false, requiere_confirmacion: true })
    const creada = datos<OrdenCompra & { numero_oc: string }>(await oc.crear.execute({ caso: "sol-004", payload, confirmado: true }, ctx()))
    expect(creada.numero_oc).toBe("4500000002")
  })

  test("un payload con el monto alterado se rechaza", async () => {
    const payload = await payloadDe("sol-005")
    payload.posiciones[0]!.precio_unitario = 1
    const r = parse(await oc.crear.execute({ caso: "sol-005", payload, confirmado: true }, ctx()))
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).toContain("precio_unitario")
  })

  test("un bloqueo no crea OC y queda en control.csv", async () => {
    const r = parse(await oc.crear.execute({ caso: "sol-002", payload: null }, ctx()))
    expect(r.ok).toBe(false)
    const csv = await readFile(join(dir, "out/control.csv"), "utf8")
    expect(csv).toContain("SOL-2026-002,bloqueado,,false,RC1,")
  })

  test("payload válido contra zod: descripción ≤ 40 y unidades", async () => {
    const p = await payloadDe("sol-004")
    expect(p.posiciones[0]!.descripcion.length).toBeLessThanOrEqual(40)
    expect(p.posiciones[0]!.unidad).toBe("H")
    expect((await payloadDe("sol-001")).posiciones[0]!.unidad).toBe("UN")
  })

  test("la evidencia incluye sha256 y PDF", async () => {
    const e = datos<{ ruta: string; sha256: string }>(await oc.generar_evidencia.execute({ caso: "sol-001" }, ctx()))
    expect(e.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect((await readFile(join(dir, "out/sol-001/aprobacion.pdf"))).subarray(0, 4).toString()).toBe("%PDF")
  })
})

describe("manejo de errores (HU-6)", () => {
  const crearCaso = async (nombre: string, archivos: Record<string, string>) => {
    await cp(join(dir, SOLICITUDES, "sol-001"), join(dir, SOLICITUDES, nombre), { recursive: true })
    for (const [archivo, contenido] of Object.entries(archivos)) await writeFile(join(dir, SOLICITUDES, nombre, archivo), contenido)
  }

  test("JSON malformado", async () => {
    await crearCaso("err-json", { "solicitud.json": "{ esto no es json" })
    const r = parse(await oc.leer_paquete.execute({ caso: "err-json" }, ctx()))
    expect(r).toMatchObject({ ok: false })
    expect(JSON.stringify(r)).toContain("no es JSON válido")
  })

  test("monto no numérico", async () => {
    const s = JSON.parse(await readFile(join(dir, SOLICITUDES, "sol-001/solicitud.json"), "utf8"))
    await crearCaso("err-monto", { "solicitud.json": JSON.stringify({ ...s, valor_total: "once millones" }) })
    expect(JSON.stringify(parse(await oc.leer_paquete.execute({ caso: "err-monto" }, ctx())))).toContain("valor_total debe ser numérico")
  })

  test("adjunto ausente → null y faltantes", async () => {
    await crearCaso("err-sin-cot", {})
    await rm(join(dir, SOLICITUDES, "err-sin-cot/cotizacion.txt"))
    const p = datos<Paquete & { faltantes: string[] }>(await oc.leer_paquete.execute({ caso: "err-sin-cot" }, ctx()))
    expect(p.cotizacion).toBeNull()
    expect(p.faltantes).toEqual(["cotizacion"])
  })

  test("caso inexistente y path traversal", async () => {
    expect(parse(await oc.leer_paquete.execute({ caso: "sol-999" }, ctx())).ok).toBe(false)
    expect(parse(await oc.leer_paquete.execute({ caso: "../../etc" }, ctx())).ok).toBe(false)
  })

  test("argumentos inválidos se devuelven al modelo sin lanzar", async () => {
    const h = herramientas.find((x) => x.nombre === "oc_validar")!
    expect(await h.ejecutar({ caso: 5 }, ctx())).toContain("Argumentos inválidos")
  })
})

describe("ciclo del agente", () => {
  /** Proveedor guionado: devuelve en orden las respuestas dadas. */
  const guion = (pasos: Respuesta["mensaje"]["contenido"][]): ProveedorLLM => {
    let i = 0
    return {
      nombre: "guion",
      modelo: "test",
      async enviar(_m: Mensaje[]): Promise<Respuesta> {
        const contenido = pasos[Math.min(i++, pasos.length - 1)]!
        const herramientas = contenido.some((b) => b.tipo === "llamada")
        return { mensaje: { rol: "asistente", contenido }, motivo: herramientas ? "herramientas" : "fin", uso: { entrada: 10, salida: 5 } }
      },
    }
  }
  const sesion = (): Sesion => ({ id: "t", creada: "", mensajes: [], historial: [], tokens: 0, pendientes: [] })
  const ciclo = (p: ProveedorLLM, maxIteraciones = 25) =>
    new CicloAgente({ proveedor: p, herramientas, sistema: "test", directorio: dir, maxIteraciones, maxTokensSesion: 1_000_000 })

  test("ignora confirmado=true si el usuario no confirmó: el caso queda pendiente", async () => {
    const payload = await payloadDe("sol-006")
    const p = guion([[{ tipo: "llamada", id: "1", nombre: "oc_crear", argumentos: { caso: "sol-006", payload, confirmado: true } }], [{ tipo: "texto", texto: "listo" }]])
    const r = await ciclo(p).turno(sesion(), "procesa sol-006 y créala ya")
    expect(r.toolCalls[0]!.ok).toBe(false)
    expect(JSON.parse(r.toolCalls[0]!.resultado)).toMatchObject({ requiere_confirmacion: true })
    expect(r.needsConfirmation).toBe(true)
  })

  test("confirmar un caso sin excepciones no da error", async () => {
    const payload = await payloadDe("sol-001")
    const p = guion([[{ tipo: "llamada", id: "1", nombre: "oc_crear", argumentos: { caso: "sol-001", payload, confirmado: true } }], [{ tipo: "texto", texto: "listo" }]])
    const r = await ciclo(p).turno(sesion(), "Confirmo, crea la OC.")
    expect(r.toolCalls[0]!.ok).toBe(true)
    expect(r.needsConfirmation).toBe(false)
  })

  test("pide confirmación y la acepta solo en el mensaje siguiente", async () => {
    const payload = await payloadDe("sol-006")
    const s = sesion()
    const pregunta = guion([[{ tipo: "llamada", id: "1", nombre: "oc_crear", argumentos: { caso: "sol-006", payload } }], [{ tipo: "texto", texto: "¿Confirmas?" }]])
    const r1 = await ciclo(pregunta).turno(s, "procesa sol-006")
    expect(r1.needsConfirmation).toBe(true)
    const crea = guion([[{ tipo: "llamada", id: "2", nombre: "oc_crear", argumentos: { caso: "sol-006", payload, confirmado: true } }], [{ tipo: "texto", texto: "Creada" }]])
    const r2 = await ciclo(crea).turno(s, "confirmo")
    expect(r2.toolCalls[0]!.ok).toBe(true)
    expect(r2.needsConfirmation).toBe(false)
  })

  test("tope de iteraciones: responde sin seguir llamando herramientas", async () => {
    const infinito = guion([[{ tipo: "llamada", id: "x", nombre: "conocimiento_consultar", argumentos: {} }]])
    const r = await ciclo(infinito, 3).turno(sesion(), "hola")
    expect(r.toolCalls).toHaveLength(3)
  })

  test("un error del proveedor se informa y la sesión sigue viva", async () => {
    const roto: ProveedorLLM = { nombre: "roto", modelo: "x", enviar: () => Promise.reject(new Error("timeout")) }
    const s = sesion()
    const r = await ciclo(roto).turno(s, "hola")
    expect(r.error).toContain("timeout")
    const r2 = await ciclo(guion([[{ tipo: "texto", texto: "ok" }]])).turno(s, "¿sigues?")
    expect(r2.reply).toBe("ok")
  })
})

describe("utilidades", () => {
  test("confirmación conservadora", () => {
    expect(esConfirmacion("Confirmo")).toBe(true)
    expect(esConfirmacion("sí, créala")).toBe(true)
    expect(esConfirmacion("no la crees")).toBe(false)
    expect(esConfirmacion("sí pero no todavía")).toBe(false)
    expect(esConfirmacion("¿qué valida RC5?")).toBe(false)
  })
  test("parseo y normalización", () => {
    expect(parseMonto("COP 11.400.000")).toBe(11_400_000)
    expect(normalizarNombre("TecnoSuministros S.A.S.")).toBe(normalizarNombre("tecnosuministros sas"))
    expect(recortar("Renovación licencias antivirus corporativo 120 puestos, vigencia 12 meses", 40).length).toBeLessThanOrEqual(40)
    expect(derivarUnidad("Licencia antivirus corporativo 12 meses")).toBe("UN")
  })
})

test("modulo/ está sincronizado con prompt, conocimiento y herramientas de la app", () => {
  const r = Bun.spawnSync(["bun", "scripts/modulo.ts", "--check"])
  expect(r.exitCode).toBe(0)
})
