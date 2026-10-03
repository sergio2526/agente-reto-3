/**
 * Verificación sin modelo (PRD 6.6): procesa los 6 casos llamando directamente a las
 * herramientas. Muestra idempotencia (sol-001 dos veces) y una confirmación explícita (sol-004).
 *
 *   bun install && bun run demo.ts
 */
import { readdir, rm } from "node:fs/promises"
import { RUTA_SOLICITUDES, rutaSegura } from "./src/lib/archivos.ts"
import * as oc from "./src/tools/oc.ts"
import type { ContextoHerramienta, Hallazgo, OrdenCompra, Paquete, Validacion } from "./src/tools/tipos.ts"

const ctx: ContextoHerramienta = { directory: process.cwd(), sessionId: "demo" }

type Salida<T> = { ok: true; data: T } | { ok: false; error: string; [k: string]: unknown }
const parse = <T>(s: string): Salida<T> => JSON.parse(s) as Salida<T>

const lista = (hs: Hallazgo[]): string => (hs.length ? hs.map((h) => `${h.codigo}: ${h.detalle}`).join("\n      ") : "—")

/** Procesa un caso de punta a punta. Devuelve true si quedó pendiente de confirmación humana. */
const procesar = async (caso: string, confirmado?: boolean): Promise<boolean> => {
  const etiqueta = confirmado ? `${caso} (confirmado)` : caso
  console.log(`\n━━ ${etiqueta} ${"━".repeat(Math.max(0, 60 - etiqueta.length))}`)
  const paquete = parse<Paquete & { faltantes: string[] }>(await oc.leer_paquete.execute({ caso }, ctx))
  if (!paquete.ok) return reportar(`  ✗ error de lectura: ${paquete.error}`)

  const v = parse<Validacion>(await oc.validar.execute({ caso, paquete: paquete.data }, ctx))
  if (!v.ok) return reportar(`  ✗ error de validación: ${v.error}`)
  const { apta, bloqueos, confirmaciones, retroactiva, derivados } = v.data
  console.log(`  apta: ${apta}   retroactiva: ${retroactiva}`)
  console.log(`  bloqueos:       ${lista(bloqueos)}`)
  console.log(`  confirmaciones: ${lista(confirmaciones)}`)
  if (Object.keys(derivados).length) console.log(`  derivados:      ${JSON.stringify(derivados)}`)

  let payload: OrdenCompra | null = null
  if (apta) {
    const p = parse<{ payload: OrdenCompra; trazabilidad: string }>(
      await oc.construir_payload.execute({ caso, paquete: paquete.data, derivados }, ctx),
    )
    if (!p.ok) return reportar(`  ✗ payload: ${p.error}`)
    payload = p.data.payload
    const pos = payload.posiciones[0]!
    console.log(`  payload:        ${payload.proveedor.codigo_sap} ${payload.proveedor.nombre} | ${pos.cantidad} ${pos.unidad} × ${pos.precio_unitario} | ${pos.centro_costo}/${pos.subarea} | IVA ${pos.indicador_iva} | pago ${payload.condiciones_pago}`)
    console.log(`  trazabilidad:   ${p.data.trazabilidad}`)
  }

  const r = parse<{ numero_oc: string; idempotente: boolean }>(await oc.crear.execute({ caso, payload, confirmado }, ctx))
  console.log(
    r.ok
      ? `  ✔ OC ${r.data.numero_oc}${r.data.idempotente ? "  (idempotente: ya existía, no se creó otra)" : ""}`
      : `  ⏸ sin OC: ${r.error}`,
  )
  return !r.ok && r.requiere_confirmacion === true
}

const reportar = (mensaje: string): false => {
  console.log(mensaje)
  return false
}

await rm(rutaSegura(ctx.directory, "out"), { recursive: true, force: true })
const casos = (await readdir(rutaSegura(ctx.directory, RUTA_SOLICITUDES))).filter((c) => c.startsWith("sol-")).sort()

for (const caso of casos) {
  const pendiente = await procesar(caso)
  if (caso === "sol-001") await procesar(caso) // idempotencia: mismo número, sin segunda OC
  if (pendiente) await procesar(caso, true) // confirmación explícita del humano
}

console.log("\nArchivos generados: out/sap/ordenes.jsonl · out/control.csv · out/<caso>/{trazabilidad.json, aprobacion.txt, aprobacion.pdf}\n")
