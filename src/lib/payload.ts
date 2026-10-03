/** Construye la OrdenCompra (PRD 7.4) y su trazabilidad campo a campo. */
import type { Derivados, Hallazgo, Maestros, OrdenCompra, Paquete, Proveedor } from "../tools/tipos.ts"
import { buscarProveedor } from "./reglas.ts"
import { recortar, normalizarNit } from "./texto.ts"

export type Fuente = "solicitud" | "cotizacion" | "correo" | "aprobacion" | `maestro.${string}` | "derivado" | "constante"
export type Traza = { campo: string; valor: string | number | null; fuente: Fuente; detalle?: string }

export const LARGO_TEXTO_BREVE = 40

/** Unidad de medida a partir del ítem cotizado (o la descripción): "Hora de…" → H, "Mes de…" → MES, resto UN. */
export const derivarUnidad = (texto: string): OrdenCompra["posiciones"][number]["unidad"] => {
  const t = texto.trim().toLowerCase()
  if (/^(bolsa de \d+ )?horas?\b/.test(t)) return "H"
  if (/^(mes|meses|mensualidad|suscripci[oó]n mensual)\b/.test(t)) return "MES"
  return "UN"
}

type Entrada = {
  paquete: Paquete
  maestros: Maestros
  derivados: Derivados
  confirmaciones: Hallazgo[]
  evidenciaSha256: string
  confirmadoPor: string | null
}

export const construirOrden = (e: Entrada): { orden: OrdenCompra; trazas: Traza[] } | { error: string } => {
  const { paquete: p, derivados: d } = e
  const s = p.solicitud
  const proveedor: Proveedor | null = buscarProveedor(p, e.maestros)
  if (!proveedor) return { error: "No se puede construir la OC: el proveedor no existe en el maestro (RC1)." }
  if (!p.aprobacion) return { error: "No se puede construir la OC: falta la aprobación (RC2)." }
  const iva = s.indicador_iva ?? d.indicador_iva?.valor
  const pago = s.condiciones_pago ?? d.condiciones_pago?.valor
  if (!iva || !pago) return { error: "No se puede construir la OC: faltan indicador de IVA o condiciones de pago y no se pudieron derivar." }

  const textoUnidad = p.cotizacion?.item ?? s.descripcion
  const orden: OrdenCompra = {
    referencia: { solicitud_id: s.solicitud_id, correo_id: p.correo.id, cotizacion_ref: p.cotizacion?.referencia ?? null },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: { codigo_sap: proveedor.codigo_sap, nit: normalizarNit(proveedor.nit), nombre: proveedor.nombre },
    moneda: s.moneda,
    condiciones_pago: pago,
    aprobador: { email: p.aprobacion.de, fecha_aprobacion: p.aprobacion.fecha, evidencia_sha256: e.evidenciaSha256 },
    posiciones: [
      {
        numero: 10,
        descripcion: recortar(s.descripcion, LARGO_TEXTO_BREVE),
        cantidad: s.cantidad,
        unidad: derivarUnidad(textoUnidad),
        precio_unitario: s.valor_unitario,
        centro_costo: s.centro_costo,
        subarea: s.subarea,
        indicador_iva: iva,
      },
    ],
    excepciones: e.confirmaciones.map((c) => ({ codigo: c.codigo, detalle: c.detalle, confirmado_por: e.confirmadoPor })),
  }

  const trazas: Traza[] = [
    { campo: "referencia.solicitud_id", valor: s.solicitud_id, fuente: "solicitud" },
    { campo: "referencia.correo_id", valor: p.correo.id, fuente: "correo" },
    { campo: "referencia.cotizacion_ref", valor: orden.referencia.cotizacion_ref, fuente: "cotizacion" },
    { campo: "sociedad", valor: "1000", fuente: "constante", detalle: "Sociedad única de la compañía (PRD 7.4)" },
    { campo: "organizacion_compras", valor: "1000", fuente: "constante", detalle: "Organización de compras única (PRD 7.4)" },
    { campo: "proveedor.codigo_sap", valor: proveedor.codigo_sap, fuente: "maestro.proveedores", detalle: s.proveedor_nit ? "Cruce por NIT" : "Cruce por nombre normalizado" },
    { campo: "proveedor.nit", valor: orden.proveedor.nit, fuente: "maestro.proveedores" },
    { campo: "proveedor.nombre", valor: proveedor.nombre, fuente: "maestro.proveedores" },
    { campo: "moneda", valor: s.moneda, fuente: "solicitud" },
    trazaDerivable("condiciones_pago", pago, s.condiciones_pago, d.condiciones_pago?.fuente),
    { campo: "aprobador.email", valor: p.aprobacion.de, fuente: "aprobacion" },
    { campo: "aprobador.fecha_aprobacion", valor: p.aprobacion.fecha, fuente: "aprobacion" },
    { campo: "aprobador.evidencia_sha256", valor: e.evidenciaSha256, fuente: "derivado", detalle: "sha256 del correo de aprobación normalizado (aprobacion.txt)" },
    { campo: "posiciones[0].numero", valor: 10, fuente: "derivado", detalle: "Numeración SAP de posiciones en pasos de 10" },
    { campo: "posiciones[0].descripcion", valor: orden.posiciones[0]!.descripcion, fuente: "solicitud", detalle: `Recortada a ${LARGO_TEXTO_BREVE} caracteres (texto breve SAP). Original: "${s.descripcion}"` },
    { campo: "posiciones[0].cantidad", valor: s.cantidad, fuente: "solicitud" },
    { campo: "posiciones[0].unidad", valor: orden.posiciones[0]!.unidad, fuente: "derivado", detalle: `Inferida del texto "${textoUnidad}"` },
    { campo: "posiciones[0].precio_unitario", valor: s.valor_unitario, fuente: "solicitud" },
    { campo: "posiciones[0].centro_costo", valor: s.centro_costo, fuente: "solicitud" },
    { campo: "posiciones[0].subarea", valor: s.subarea, fuente: "solicitud" },
    trazaDerivable("posiciones[0].indicador_iva", iva, s.indicador_iva, d.indicador_iva?.fuente),
    { campo: "excepciones", valor: orden.excepciones.map((x) => x.codigo).join(",") || null, fuente: "derivado", detalle: "Confirmaciones de oc_validar" },
  ]
  return { orden, trazas }
}

const trazaDerivable = (campo: string, valor: string, original: string | undefined, fuenteDerivada?: string): Traza =>
  original !== undefined
    ? { campo, valor, fuente: "solicitud" }
    : { campo, valor, fuente: "derivado", detalle: `No informado en la solicitud; tomado de ${fuenteDerivada ?? "maestro"}` }
