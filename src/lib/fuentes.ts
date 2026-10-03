import { z } from "zod"
import {
  AprobacionFixtureSchema,
  CentroCostoSchema,
  CodigoMaestroSchema,
  CorreoFixtureSchema,
  ProveedorSchema,
  SolicitudSchema,
  type AprobacionFixture,
  type Maestros,
  type Paquete,
  type Resultado,
} from "../tools/tipos.ts"
import { RUTA_MAESTROS, RUTA_SOLICITUDES, casoValido, existe, leerJson, leerTexto, rutaSegura } from "./archivos.ts"
import { campo, contieneAprobado, normalizarNit, parseMonto, sumarDias } from "./texto.ts"

// ── Maestros ─────────────────────────────────────────────────────────────────

const leerMaestro = async <T>(directorio: string, archivo: string, esquema: z.ZodType<T>): Promise<Resultado<T[]>> => {
  const crudo = await leerJson(rutaSegura(directorio, RUTA_MAESTROS, archivo), archivo)
  if (crudo === null) return { ok: false, error: `No existe el maestro ${archivo}` }
  if (!crudo.ok) return crudo
  const r = z.array(esquema).safeParse(crudo.data)
  return r.success ? { ok: true, data: r.data } : { ok: false, error: `Maestro ${archivo} inválido: ${resumirZod(r.error)}` }
}

export const leerMaestros = async (directorio: string): Promise<Resultado<Maestros>> => {
  const [proveedores, centrosCosto, indicadoresIva, condicionesPago] = await Promise.all([
    leerMaestro(directorio, "proveedores.json", ProveedorSchema),
    leerMaestro(directorio, "centros-costo.json", CentroCostoSchema),
    leerMaestro(directorio, "indicadores-iva.json", CodigoMaestroSchema),
    leerMaestro(directorio, "condiciones-pago.json", CodigoMaestroSchema),
  ])
  if (!proveedores.ok) return proveedores
  if (!centrosCosto.ok) return centrosCosto
  if (!indicadoresIva.ok) return indicadoresIva
  if (!condicionesPago.ok) return condicionesPago
  return {
    ok: true,
    data: {
      proveedores: proveedores.data,
      centrosCosto: centrosCosto.data,
      indicadoresIva: indicadoresIva.data,
      condicionesPago: condicionesPago.data,
    },
  }
}

// ── Documentos de texto ──────────────────────────────────────────────────────

export const parsearCotizacion = (texto: string): NonNullable<Paquete["cotizacion"]> => {
  const totalLinea = texto.match(/^\s*TOTAL[^:\n]*:\s*([A-Z]{3})?\s*([\d.,]+)/im)
  const fechaCot = campo(texto, /Fecha/)
  const diasValidez = Number(campo(texto, /Validez[^:]*/)?.match(/\d+/)?.[0])
  const nit = campo(texto, /NIT/)
  const item = texto.match(/^\s*1\.\s*([^|\n]+)/m)?.[1]?.trim() ?? null
  return {
    referencia: texto.match(/COTIZACI[ÓO]N\s+([A-Z0-9-]+)/i)?.[1] ?? null,
    proveedor: campo(texto, /Proveedor/) ?? "",
    nit: nit ? normalizarNit(nit) : null,
    total: totalLinea ? (parseMonto(totalLinea[2] ?? "") ?? Number.NaN) : Number.NaN,
    moneda: totalLinea?.[1] ?? "COP",
    validez_hasta: fechaCot && Number.isFinite(diasValidez) ? sumarDias(fechaCot, diasValidez) : null,
    item,
    texto,
  }
}

export const parsearFactura = (texto: string): NonNullable<Paquete["factura"]> => {
  const total = texto.match(/^\s*TOTAL\s*:\s*[A-Z]{0,3}\s*([\d.,]+)/im)?.[1]
  return {
    numero: texto.match(/\bNo\.\s*([A-Z0-9-]+)/)?.[1] ?? "",
    fecha: (campo(texto, /Fecha(?: de emisi[óo]n)?/) ?? "").slice(0, 10),
    total: total ? (parseMonto(total) ?? Number.NaN) : Number.NaN,
  }
}

const normalizarAprobacion = (a: AprobacionFixture): NonNullable<Paquete["aprobacion"]> => ({
  de: a.de.trim().toLowerCase(),
  fecha: a.fecha,
  aprobado: contieneAprobado(a.cuerpo),
  texto: a.cuerpo,
})

// ── Paquete ──────────────────────────────────────────────────────────────────

export type LecturaPaquete = { paquete: Paquete; faltantes: string[]; aprobacion_original: AprobacionFixture | null }

const resumirZod = (e: z.ZodError): string =>
  e.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ")

const parsearJson = async <T>(
  carpeta: string,
  archivo: string,
  esquema: z.ZodType<T>,
): Promise<Resultado<T> | null> => {
  const crudo = await leerJson(rutaSegura(carpeta, archivo), archivo)
  if (crudo === null || !crudo.ok) return crudo
  const r = esquema.safeParse(crudo.data)
  return r.success ? { ok: true, data: r.data } : { ok: false, error: `${archivo} con datos inválidos: ${resumirZod(r.error)}` }
}

const ACCION_FALTANTE: Record<string, string> = {
  "correo.json": "el correo original de la solicitud",
  "solicitud.json": "el Excel de solicitud (solicitud.xlsx)",
}

export const leerPaquete = async (directorio: string, caso: string): Promise<Resultado<LecturaPaquete>> => {
  if (!casoValido(caso)) return { ok: false, error: `Nombre de caso inválido: "${caso}". Usa el nombre de la carpeta, p. ej. "sol-001".` }
  const carpeta = rutaSegura(directorio, RUTA_SOLICITUDES, caso)
  if (!(await existe(carpeta))) return { ok: false, error: `No existe el caso "${caso}" en ${RUTA_SOLICITUDES}/` }

  const [correo, solicitud, aprobacion] = await Promise.all([
    parsearJson(carpeta, "correo.json", CorreoFixtureSchema),
    parsearJson(carpeta, "solicitud.json", SolicitudSchema),
    parsearJson(carpeta, "aprobacion.json", AprobacionFixtureSchema),
  ])
  const [cotizacionTxt, facturaTxt] = await Promise.all([
    leerTexto(rutaSegura(carpeta, "cotizacion.txt")),
    leerTexto(rutaSegura(carpeta, "factura.txt")),
  ])

  const obligatorios = { "correo.json": correo, "solicitud.json": solicitud }
  for (const [archivo, r] of Object.entries(obligatorios)) {
    if (r === null)
      return { ok: false, error: `Paquete incompleto: falta ${archivo}.`, sugerencia: `Pedir al solicitante ${ACCION_FALTANTE[archivo]}.` }
    if (!r.ok) return { ...r, sugerencia: `Pedir al solicitante que reenvíe ${ACCION_FALTANTE[archivo]} corregido.` }
  }
  if (aprobacion && !aprobacion.ok)
    return { ...aprobacion, sugerencia: "Pedir al líder que reenvíe el correo de aprobación." }
  if (!correo?.ok || !solicitud?.ok) return { ok: false, error: "Paquete incompleto" }

  const cotizacion = cotizacionTxt === null ? null : parsearCotizacion(cotizacionTxt)
  if (cotizacion && !Number.isFinite(cotizacion.total))
    return { ok: false, error: "La cotización no tiene un TOTAL numérico legible.", sugerencia: "Pedir al proveedor la cotización con el total explícito." }
  const factura = facturaTxt === null ? null : parsearFactura(facturaTxt)
  if (factura && (!Number.isFinite(factura.total) || !/^\d{4}-\d{2}-\d{2}$/.test(factura.fecha)))
    return { ok: false, error: "La factura adjunta no tiene fecha o total legibles.", sugerencia: "Pedir la factura en formato legible." }

  const faltantes = [cotizacion ? null : "cotizacion", aprobacion ? null : "aprobacion"].filter((x): x is string => x !== null)
  const c = correo.data
  return {
    ok: true,
    data: {
      paquete: {
        correo: { id: c.id, de: c.de, asunto: c.asunto, fecha: c.fecha },
        solicitud: solicitud.data,
        cotizacion,
        aprobacion: aprobacion ? normalizarAprobacion(aprobacion.data) : null,
        factura,
      },
      faltantes,
      aprobacion_original: aprobacion?.data ?? null,
    },
  }
}
