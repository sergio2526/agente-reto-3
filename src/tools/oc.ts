/**
 * Herramientas del agente de órdenes de compra. Cada export es una herramienta
 * y el modelo la ve como `oc_<export>`. Todas devuelven JSON `{ ok, data | error }`
 * y nunca lanzan: cualquier excepción inesperada se convierte en `{ ok: false }`.
 *
 * Principio de diseño: el modelo pasa `paquete`, `derivados` y `payload` de una
 * herramienta a otra, pero cada herramienta los vuelve a calcular desde los
 * fixtures y rechaza cualquier valor alterado. El modelo no puede "arreglar" montos.
 */
import { z } from "zod"
import { escribir, rutaOut } from "../lib/archivos.ts"
import { registrarControl } from "../lib/control.ts"
import { pdfEvidencia, textoEvidencia } from "../lib/evidencia.ts"
import { leerMaestros, leerPaquete, type LecturaPaquete } from "../lib/fuentes.ts"
import { construirOrden } from "../lib/payload.ts"
import { validarPaquete } from "../lib/reglas.ts"
import { SapMock } from "../sap/mock.ts"
import type { SapAdapter } from "../sap/adapter.ts"
import {
  DerivadosSchema,
  OrdenCompraSchema,
  PaqueteSchema,
  fallo,
  herramienta,
  ok,
  type ContextoHerramienta,
  type Maestros,
  type OrdenCompra,
  type Paquete,
  type Validacion,
} from "./tipos.ts"

const caso = z.string().describe('Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/, p. ej. "sol-001"')

// ── Infraestructura compartida ───────────────────────────────────────────────

const adaptadores = new Map<string, SapAdapter>()
const sap = (directorio: string): SapAdapter => {
  const existente = adaptadores.get(directorio)
  if (existente) return existente
  const nuevo = new SapMock(directorio)
  adaptadores.set(directorio, nuevo)
  return nuevo
}

type Expediente = LecturaPaquete & { maestros: Maestros; validacion: Validacion }

/** Lee el caso desde los fixtures y lo valida. Es la única fuente de verdad de todas las herramientas. */
const expediente = async (directorio: string, nombreCaso: string): Promise<{ ok: true; data: Expediente } | { ok: false; json: string }> => {
  const lectura = await leerPaquete(directorio, nombreCaso)
  if (!lectura.ok) return { ok: false, json: JSON.stringify(lectura) }
  const maestros = await leerMaestros(directorio)
  if (!maestros.ok) return { ok: false, json: fallo(maestros.error) }
  const validacion = validarPaquete(lectura.data.paquete, maestros.data)
  return { ok: true, data: { ...lectura.data, maestros: maestros.data, validacion } }
}

/** Ejecuta el cuerpo de la herramienta garantizando que nunca lance. */
const seguro = async (cuerpo: () => Promise<string>): Promise<string> => {
  try {
    return await cuerpo()
  } catch (e) {
    return fallo(`Error interno de la herramienta: ${(e as Error).message}`)
  }
}

/** Rutas (a.b[0].c) donde dos valores JSON difieren. */
const diferencias = (a: unknown, b: unknown, ruta = ""): string[] => {
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null)
    return Object.is(a, b) ? [] : [ruta || "(raíz)"]
  if (Array.isArray(a) !== Array.isArray(b)) return [ruta || "(raíz)"]
  const claves = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...claves].flatMap((k) => {
    const sub = Array.isArray(a) ? `${ruta}[${k}]` : ruta ? `${ruta}.${k}` : k
    return diferencias((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], sub)
  })
}

/** Campos del paquete que deciden reglas o montos; el texto libre no se compara. */
const huella = (p: Paquete) => ({
  correo: p.correo,
  solicitud: p.solicitud,
  cotizacion: p.cotizacion && { total: p.cotizacion.total, moneda: p.cotizacion.moneda, nit: p.cotizacion.nit, referencia: p.cotizacion.referencia },
  aprobacion: p.aprobacion && { de: p.aprobacion.de, fecha: p.aprobacion.fecha, aprobado: p.aprobacion.aprobado },
  factura: p.factura,
})

const verificarRecibido = (nombre: string, recibido: unknown, canonico: unknown): string | null => {
  const d = diferencias(recibido, canonico)
  return d.length
    ? fallo(`El ${nombre} recibido no coincide con el calculado desde los fixtures (campos: ${d.slice(0, 8).join(", ")}). No modifiques valores: usa exactamente la salida de la herramienta anterior.`)
    : null
}

const evidenciaDe = (e: Expediente) => (e.aprobacion_original ? textoEvidencia(e.aprobacion_original) : null)

const ordenCanonica = (e: Expediente, confirmadoPor: string | null) => {
  const evidencia = evidenciaDe(e)
  if (!evidencia) return { error: "No hay correo de aprobación para generar la evidencia (RC2)." }
  return construirOrden({
    paquete: e.paquete,
    maestros: e.maestros,
    derivados: e.validacion.derivados,
    confirmaciones: e.validacion.confirmaciones,
    evidenciaSha256: evidencia.hash,
    confirmadoPor,
  })
}

const sinConfirmador = (o: OrdenCompra): OrdenCompra => ({ ...o, excepciones: o.excepciones.map((x) => ({ ...x, confirmado_por: null })) })

const codigos = (v: Validacion) => ({ bloqueos: v.bloqueos.map((b) => b.codigo), confirmaciones: v.confirmaciones.map((c) => c.codigo) })

// ── Herramientas ─────────────────────────────────────────────────────────────

export const leer_paquete = herramienta({
  description:
    "Lee y normaliza el paquete de un caso (correo, solicitud, cotización, aprobación y factura si existe); los adjuntos ausentes vienen como null y se listan en `faltantes`.",
  args: { caso },
  execute: ({ caso }, ctx) =>
    seguro(async () => {
      const r = await leerPaquete(ctx.directory, caso)
      return r.ok ? ok({ ...r.data.paquete, faltantes: r.data.faltantes }) : JSON.stringify(r)
    }),
})

export const validar = herramienta({
  description:
    "Aplica las reglas de control RC1–RC10 al paquete contra los maestros y devuelve { apta, bloqueos, confirmaciones, derivados, retroactiva }.",
  args: {
    caso,
    paquete: PaqueteSchema.describe("Paquete exactamente como lo devolvió oc_leer_paquete (sin `faltantes`)"),
  },
  execute: ({ caso, paquete }, ctx) =>
    seguro(async () => {
      const e = await expediente(ctx.directory, caso)
      if (!e.ok) return e.json
      return verificarRecibido("paquete", huella(paquete), huella(e.data.paquete)) ?? ok(e.data.validacion)
    }),
})

export const construir_payload = herramienta({
  description:
    "Construye la orden de compra tal como quedaría en SAP (validada con zod) y guarda la trazabilidad de cada campo en out/<caso>/trazabilidad.json.",
  args: {
    caso,
    paquete: PaqueteSchema.describe("Paquete exactamente como lo devolvió oc_leer_paquete"),
    derivados: DerivadosSchema.describe("Objeto `derivados` exactamente como lo devolvió oc_validar"),
  },
  execute: ({ caso, paquete, derivados }, ctx) =>
    seguro(async () => {
      const e = await expediente(ctx.directory, caso)
      if (!e.ok) return e.json
      const alterado =
        verificarRecibido("paquete", huella(paquete), huella(e.data.paquete)) ??
        verificarRecibido("objeto derivados", derivados, e.data.validacion.derivados)
      if (alterado) return alterado
      if (!e.data.validacion.apta)
        return fallo("La solicitud tiene bloqueos; no se construye la OC.", codigos(e.data.validacion))
      const r = ordenCanonica(e.data, null)
      if ("error" in r) return fallo(r.error)
      const orden = OrdenCompraSchema.parse(r.orden)
      const trazabilidad = rutaOut(ctx.directory, caso, "trazabilidad.json")
      await escribir(trazabilidad, JSON.stringify({ caso, solicitud_id: orden.referencia.solicitud_id, campos: r.trazas }, null, 2))
      return ok({ payload: orden, trazabilidad: `out/${caso}/trazabilidad.json` })
    }),
})

export const generar_evidencia = herramienta({
  description:
    "Genera la evidencia de aprobación del caso en out/<caso>/aprobacion.txt y aprobacion.pdf, con el sha256 del contenido.",
  args: { caso },
  execute: ({ caso }, ctx) =>
    seguro(async () => {
      const r = await leerPaquete(ctx.directory, caso)
      if (!r.ok) return JSON.stringify(r)
      const aprobacion = r.data.aprobacion_original
      if (!aprobacion) return fallo("El caso no trae correo de aprobación; no hay evidencia que generar.", { sugerencia: "Pedir al líder el correo de aprobación." })
      const { texto, hash } = textoEvidencia(aprobacion)
      await escribir(rutaOut(ctx.directory, caso, "aprobacion.txt"), texto)
      await escribir(rutaOut(ctx.directory, caso, "aprobacion.pdf"), await pdfEvidencia(aprobacion, texto))
      return ok({ ruta: `out/${caso}/aprobacion.txt`, ruta_pdf: `out/${caso}/aprobacion.pdf`, sha256: hash })
    }),
})

export const crear = herramienta({
  description:
    "Crea la OC en SAP (simulado) solo si la solicitud es apta y, cuando hay confirmaciones, el usuario las confirmó (confirmado=true); registra cada intento en out/control.csv.",
  args: {
    caso,
    payload: OrdenCompraSchema.nullable().describe(
      "Payload exactamente como lo devolvió oc_construir_payload; null si la solicitud tiene bloqueos (solo registra el intento)",
    ),
    confirmado: z
      .boolean()
      .optional()
      .describe("true solo si el usuario confirmó explícitamente en su último mensaje las confirmaciones pendientes"),
  },
  execute: (args, ctx) => seguro(() => crearOrden(args, ctx)),
})

const crearOrden = async (
  args: { caso: string; payload: OrdenCompra | null; confirmado?: boolean },
  ctx: ContextoHerramienta,
): Promise<string> => {
  const e = await expediente(ctx.directory, args.caso)
  if (!e.ok) return e.json
  const { validacion: v, paquete } = e.data
  const base = { solicitud_id: paquete.solicitud.solicitud_id, retroactiva: v.retroactiva, ...codigos(v) }
  const adaptador = sap(ctx.directory)

  const previa = await adaptador.buscarOrdenPorReferencia(paquete.solicitud.solicitud_id)
  if (previa) {
    await registrarControl(ctx.directory, { ...base, resultado: "idempotente", numero_oc: previa.numero_oc })
    return ok({ numero_oc: previa.numero_oc, fecha: null, idempotente: true, mensaje: "La OC ya existía para esta solicitud; no se creó otra." })
  }
  if (!v.apta) {
    await registrarControl(ctx.directory, { ...base, resultado: "bloqueado", numero_oc: null })
    return fallo("Solicitud bloqueada: no se crea la OC.", { bloqueos: v.bloqueos })
  }
  if (v.confirmaciones.length > 0 && args.confirmado !== true) {
    await registrarControl(ctx.directory, { ...base, resultado: "pendiente", numero_oc: null })
    return fallo("Requiere confirmación humana antes de crear la OC.", { requiere_confirmacion: true, confirmaciones: v.confirmaciones })
  }

  const confirmadoPor = v.confirmaciones.length ? `analista (sesión ${ctx.sessionId})` : null
  const r = ordenCanonica(e.data, confirmadoPor)
  if ("error" in r) return fallo(r.error)
  if (!args.payload) return fallo("Falta el payload: llama primero a oc_construir_payload y pásalo sin cambios.")
  const alterado = verificarRecibido("payload", sinConfirmador(args.payload), sinConfirmador(r.orden))
  if (alterado) {
    await registrarControl(ctx.directory, { ...base, resultado: "error", numero_oc: null })
    return alterado
  }

  const enSap = await adaptador.consultarProveedor(r.orden.proveedor.nit)
  if (!enSap?.activo) return fallo(`SAP no reporta activo al proveedor ${r.orden.proveedor.nit}.`)
  const evidencia = await generar_evidencia.execute({ caso: args.caso }, ctx)
  const creada = await adaptador.crearOrden(OrdenCompraSchema.parse(r.orden))
  await registrarControl(ctx.directory, { ...base, resultado: "exitoso", numero_oc: creada.numero_oc })
  return ok({
    numero_oc: creada.numero_oc,
    fecha: creada.fecha,
    idempotente: false,
    retroactiva: v.retroactiva,
    evidencia: (JSON.parse(evidencia) as { data?: unknown }).data ?? null,
    excepciones_confirmadas: r.orden.excepciones,
  })
}
