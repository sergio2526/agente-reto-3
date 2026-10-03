/**
 * Proveedor "simulado": implementa la misma interfaz que un LLM real con un guion
 * determinista. Sirve para probar la interfaz sin clave y demuestra que el ciclo del
 * agente no depende del proveedor. Solo entiende "procesa sol-00X" y confirmaciones.
 */
import { esConfirmacion } from "../agent/confirmacion.ts"
import type { Hallazgo, OrdenCompra, Validacion } from "../tools/tipos.ts"
import type { DefinicionHerramienta, Mensaje, MensajeAsistente, ProveedorLLM, Respuesta } from "./adapter.ts"

type Salida = { ok: boolean; data?: unknown; error?: string; [k: string]: unknown }

export class ProveedorSimulado implements ProveedorLLM {
  readonly nombre = "simulado"
  readonly modelo = "guion-determinista"
  private contador = 0

  async enviar(mensajes: Mensaje[], _herramientas: DefinicionHerramienta[]): Promise<Respuesta> {
    const turno = turnoActual(mensajes)
    const caso = buscarCaso(mensajes)
    if (!caso) return texto(AYUDA)
    const mencionaCaso = /sol-\d+/i.test(turno.texto)
    const confirmo = esConfirmacion(turno.texto) && !mencionaCaso
    if (!mencionaCaso && !confirmo) return texto(`Entendido, no hago cambios en **${caso}**. Pídeme procesar otra solicitud cuando quieras.`)
    const r = turno.resultados

    const leido = r.get("oc_leer_paquete")
    if (!leido) return this.llamar("oc_leer_paquete", { caso })
    if (!leido.ok) return texto(`No pude leer el paquete de **${caso}**: ${leido.error}\n\n${String(leido.sugerencia ?? "")}`)
    const { faltantes: _f, ...paquete } = leido.data as Record<string, unknown>

    const validado = r.get("oc_validar")
    if (!validado) return this.llamar("oc_validar", { caso, paquete })
    if (!validado.ok) return texto(`La validación falló: ${validado.error}`)
    const v = validado.data as Validacion

    if (!v.apta) {
      if (!r.has("oc_crear")) return this.llamar("oc_crear", { caso, payload: null })
      return texto(`### ${caso}: OC bloqueada\n\nNo se crea la orden de compra.\n\n${hallazgos("Bloqueos", v.bloqueos)}`)
    }

    const construido = r.get("oc_construir_payload")
    if (!construido) return this.llamar("oc_construir_payload", { caso, paquete, derivados: v.derivados })
    if (!construido.ok) return texto(`No pude construir el payload: ${construido.error}`)
    const { payload, trazabilidad } = construido.data as { payload: OrdenCompra; trazabilidad: string }

    if (!r.has("oc_generar_evidencia")) return this.llamar("oc_generar_evidencia", { caso })

    const creado = r.get("oc_crear")
    if (!creado) return this.llamar("oc_crear", { caso, payload, ...(confirmo && v.confirmaciones.length ? { confirmado: true } : {}) })
    const tabla = tablaPayload(payload, trazabilidad)
    if (creado.ok) {
      const d = creado.data as { numero_oc: string; idempotente: boolean }
      const evidencia = (r.get("oc_generar_evidencia")?.data as { ruta?: string } | undefined)?.ruta ?? `out/${caso}/aprobacion.txt`
      return texto(
        `### ${caso}: OC ${d.numero_oc} ${d.idempotente ? "(ya existía, no se duplicó)" : "creada"}\n\n${tabla}\n\nEvidencia: \`${evidencia}\`${v.retroactiva ? "\n\n⚠️ Quedó marcada **retroactiva = true** en `out/control.csv`." : ""}`,
      )
    }
    if (creado.requiere_confirmacion)
      return texto(
        `### ${caso}: lista para crear, requiere tu confirmación\n\n${tabla}\n\n${hallazgos("Confirmaciones pendientes", v.confirmaciones)}\n\n**¿Confirmas la creación de la OC con estos valores?** Responde "confirmo" para crearla.`,
      )
    return texto(`No se creó la OC: ${creado.error}`)
  }

  private llamar(nombre: string, argumentos: unknown): Respuesta {
    this.contador += 1
    const mensaje: MensajeAsistente = { rol: "asistente", contenido: [{ tipo: "llamada", id: `sim_${this.contador}`, nombre, argumentos }] }
    return { mensaje, motivo: "herramientas", uso: { entrada: 0, salida: 0 } }
  }
}

const AYUDA =
  'Soy el modo **simulado** (sin modelo de lenguaje). Escribe por ejemplo: "Procesa la solicitud sol-004". Para conversación libre configura `LLM_PROVIDER=anthropic`.'

const texto = (t: string): Respuesta => ({ mensaje: { rol: "asistente", contenido: [{ tipo: "texto", texto: t }] }, motivo: "fin", uso: { entrada: 0, salida: 0 } })

/** Texto del último mensaje humano y resultados de herramientas posteriores, por nombre. */
const turnoActual = (mensajes: Mensaje[]): { texto: string; resultados: Map<string, Salida> } => {
  const inicio = mensajes.findLastIndex((m) => m.rol === "usuario" && m.contenido.some((b) => b.tipo === "texto"))
  const humano = mensajes[inicio]
  const textoHumano = humano?.rol === "usuario" ? humano.contenido.flatMap((b) => (b.tipo === "texto" ? [b.texto] : [])).join(" ") : ""
  const nombres = new Map<string, string>()
  const resultados = new Map<string, Salida>()
  for (const m of mensajes.slice(inicio + 1))
    for (const b of m.contenido) {
      if (b.tipo === "llamada") nombres.set(b.id, b.nombre)
      if (b.tipo === "resultado") resultados.set(nombres.get(b.id) ?? "?", JSON.parse(b.contenido) as Salida)
    }
  return { texto: textoHumano, resultados }
}

const buscarCaso = (mensajes: Mensaje[]): string | null => {
  for (const m of [...mensajes].reverse())
    if (m.rol === "usuario")
      for (const b of m.contenido) if (b.tipo === "texto") {
        const c = b.texto.match(/sol-\d{3}/i)?.[0]
        if (c) return c.toLowerCase()
      }
  return null
}

const hallazgos = (titulo: string, hs: Hallazgo[]): string =>
  `**${titulo}:**\n${hs.map((h) => `- **${h.codigo}** — ${h.detalle}\n  - Acción sugerida: ${h.accion_sugerida}`).join("\n")}`

const tablaPayload = (o: OrdenCompra, trazabilidad: string): string => {
  const p = o.posiciones[0]!
  const filas: Array<[string, string]> = [
    ["Proveedor", `${o.proveedor.codigo_sap} · ${o.proveedor.nombre} (NIT ${o.proveedor.nit})`],
    ["Descripción", p.descripcion],
    ["Cantidad × precio", `${p.cantidad} ${p.unidad} × ${o.moneda} ${p.precio_unitario.toLocaleString("es-CO")}`],
    ["Total", `${o.moneda} ${(p.cantidad * p.precio_unitario).toLocaleString("es-CO")}`],
    ["Centro de costo / subárea", `${p.centro_costo} / ${p.subarea}`],
    ["Indicador IVA", p.indicador_iva],
    ["Condiciones de pago", o.condiciones_pago],
    ["Aprobador", `${o.aprobador.email} (${o.aprobador.fecha_aprobacion})`],
    ["Cotización", o.referencia.cotizacion_ref ?? "—"],
  ]
  return `| Campo | Valor |\n|---|---|\n${filas.map(([c, v]) => `| ${c} | ${v} |`).join("\n")}\n\nTrazabilidad: \`${trazabilidad}\``
}
