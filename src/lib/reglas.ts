/**
 * Reglas de control RC1–RC10 (PRD 7.3). Funciones puras: reciben el paquete y los
 * maestros, devuelven hallazgos. Cambiar una política de negocio se hace aquí.
 */
import type { CentroCosto, Derivados, Hallazgo, Maestros, Paquete, Proveedor, Validacion } from "../tools/tipos.ts"
import { formatoMoneda, normalizarNit, normalizarNombre, soloFecha } from "./texto.ts"

export const POLITICA = {
  toleranciaCotizacion: 0.02, // RC5: 2 %
  toleranciaAritmetica: 1, // RC10: ± 1 unidad monetaria
} as const

type Hallazgos = { bloqueos: Hallazgo[]; confirmaciones: Hallazgo[] }
type Contexto = { paquete: Paquete; maestros: Maestros; proveedor: Proveedor | null; centro: CentroCosto | null }

export const buscarProveedor = (paquete: Paquete, maestros: Maestros): Proveedor | null => {
  const { proveedor_nit, proveedor_nombre } = paquete.solicitud
  if (proveedor_nit) return maestros.proveedores.find((p) => normalizarNit(p.nit) === normalizarNit(proveedor_nit)) ?? null
  const nombre = normalizarNombre(proveedor_nombre)
  return maestros.proveedores.find((p) => normalizarNombre(p.nombre) === nombre) ?? null
}

const rc1Proveedor = ({ paquete, proveedor }: Contexto, h: Hallazgos): void => {
  const s = paquete.solicitud
  const criterio = s.proveedor_nit ? `NIT ${s.proveedor_nit}` : `nombre "${s.proveedor_nombre}"`
  if (!proveedor)
    h.bloqueos.push({
      codigo: "RC1",
      detalle: `El proveedor ${s.proveedor_nombre} (${criterio}) no existe en el maestro de proveedores.`,
      accion_sugerida: "Solicitar a Compras la creación del proveedor en SAP (RUT, certificación bancaria) o pedir al solicitante una cotización de un proveedor registrado.",
      valores: { proveedor: s.proveedor_nombre, nit: s.proveedor_nit ?? null },
    })
  else if (!proveedor.activo)
    h.bloqueos.push({
      codigo: "RC1",
      detalle: `El proveedor ${proveedor.nombre} (${proveedor.codigo_sap}) está inactivo en el maestro.`,
      accion_sugerida: "Solicitar a Compras la reactivación del proveedor o elegir otro proveedor activo.",
      valores: { codigo_sap: proveedor.codigo_sap },
    })
}

const rc2rc3Aprobacion = ({ paquete, centro }: Contexto, h: Hallazgos): void => {
  const { aprobacion, solicitud: s } = paquete
  const aprobadoresCc = centro?.aprobadores ?? []
  const listado = aprobadoresCc.map((a) => `${a.email} (tope ${formatoMoneda(a.tope, s.moneda)})`).join(", ") || "ninguno"
  if (!aprobacion || !aprobacion.aprobado) {
    h.bloqueos.push({
      codigo: "RC2",
      detalle: aprobacion
        ? `El correo de ${aprobacion.de} no contiene la palabra "Aprobado".`
        : "El paquete no trae correo de aprobación.",
      accion_sugerida: `Solicitar la aprobación explícita ("Aprobado") a un aprobador de ${s.centro_costo}: ${listado}.`,
    })
    return
  }
  const aprobador = aprobadoresCc.find((a) => a.email.toLowerCase() === aprobacion.de)
  if (!aprobador) {
    const conTope = aprobadoresCc.filter((a) => a.tope >= s.valor_total).map((a) => a.email)
    h.bloqueos.push({
      codigo: "RC2",
      detalle: `${aprobacion.de} no es aprobador del centro de costo ${s.centro_costo}. Aprobadores autorizados: ${listado}.`,
      accion_sugerida: conTope.length
        ? `Solicitar la aprobación a ${conTope.join(" o ")}.`
        : `Ningún aprobador de ${s.centro_costo} tiene tope para ${formatoMoneda(s.valor_total, s.moneda)}: escalar a la matriz de aprobación o corregir el centro de costo con el solicitante.`,
      valores: { aprobador: aprobacion.de, centro_costo: s.centro_costo },
    })
    return
  }
  if (s.valor_total > aprobador.tope)
    h.bloqueos.push({
      codigo: "RC3",
      detalle: `El valor ${formatoMoneda(s.valor_total, s.moneda)} supera el tope de ${aprobador.email} (${formatoMoneda(aprobador.tope, s.moneda)}) en ${s.centro_costo}.`,
      accion_sugerida: "Solicitar la aprobación a un aprobador del centro de costo con tope suficiente.",
      valores: { valor_total: s.valor_total, tope: aprobador.tope },
    })
}

const rc4Subarea = ({ paquete, centro }: Contexto, h: Hallazgos): void => {
  const s = paquete.solicitud
  if (!centro)
    h.bloqueos.push({
      codigo: "RC4",
      detalle: `El centro de costo ${s.centro_costo} no existe en el maestro.`,
      accion_sugerida: "Confirmar con el solicitante el centro de costo correcto.",
    })
  else if (!centro.subareas.includes(s.subarea))
    h.bloqueos.push({
      codigo: "RC4",
      detalle: `La subárea "${s.subarea}" no pertenece a ${s.centro_costo}. Subáreas válidas: ${centro.subareas.join(", ")}.`,
      accion_sugerida: "Confirmar con el solicitante la subárea correcta.",
    })
}

const rc5Cotizacion = ({ paquete }: Contexto, h: Hallazgos): void => {
  const { cotizacion: c, solicitud: s } = paquete
  if (!c) {
    h.confirmaciones.push({
      codigo: "RC5",
      detalle: "El paquete no trae cotización del proveedor.",
      accion_sugerida: "Confirmar que se crea la OC sin cotización o pedirla al solicitante.",
      valores: { solicitud: s.valor_total, cotizacion: null },
    })
    return
  }
  const diferencia = Math.abs(c.total - s.valor_total) / s.valor_total
  if (diferencia > POLITICA.toleranciaCotizacion || c.moneda !== s.moneda)
    h.confirmaciones.push({
      codigo: "RC5",
      detalle: `La cotización (${formatoMoneda(c.total, c.moneda)}) difiere de la solicitud (${formatoMoneda(s.valor_total, s.moneda)}) en ${(diferencia * 100).toFixed(2)} % (tolerancia ${POLITICA.toleranciaCotizacion * 100} %). La OC se crea por el valor de la solicitud, que es el aprobado.`,
      accion_sugerida: "Confirmar que se crea por el valor de la solicitud, o pedir al solicitante que ajuste la solicitud y obtenga nueva aprobación.",
      valores: { solicitud: s.valor_total, cotizacion: c.total, diferencia_pct: Number((diferencia * 100).toFixed(2)) },
    })
}

const rc6rc7Derivados = ({ paquete, maestros, proveedor }: Contexto, h: Hallazgos, d: Derivados): void => {
  const s = paquete.solicitud
  if (s.indicador_iva === undefined) {
    if (proveedor) {
      d.indicador_iva = { valor: proveedor.indicador_iva_default, fuente: "maestro.proveedores" }
      h.confirmaciones.push({
        codigo: "RC6",
        detalle: `La solicitud no informa indicador de IVA. Se deriva ${proveedor.indicador_iva_default} (${descripcion(maestros.indicadoresIva, proveedor.indicador_iva_default)}) del maestro del proveedor ${proveedor.nombre}`,
        accion_sugerida: "Confirmar el indicador de IVA derivado.",
        valores: { indicador_iva_derivado: proveedor.indicador_iva_default },
      })
    }
  } else if (!maestros.indicadoresIva.some((i) => i.codigo === s.indicador_iva))
    h.bloqueos.push({
      codigo: "RC6",
      detalle: `El indicador de IVA "${s.indicador_iva}" no existe en el maestro.`,
      accion_sugerida: `Corregir el indicador con el solicitante. Válidos: ${maestros.indicadoresIva.map((i) => i.codigo).join(", ")}.`,
    })

  if (s.condiciones_pago === undefined) {
    if (proveedor) d.condiciones_pago = { valor: proveedor.condiciones_pago_default, fuente: "maestro.proveedores" }
  } else if (!maestros.condicionesPago.some((c) => c.codigo === s.condiciones_pago))
    h.bloqueos.push({
      codigo: "RC7",
      detalle: `La condición de pago "${s.condiciones_pago}" no existe en el maestro.`,
      accion_sugerida: `Corregir con el solicitante. Válidas: ${maestros.condicionesPago.map((c) => c.codigo).join(", ")}.`,
    })
}

const descripcion = (lista: Maestros["indicadoresIva"], codigo: string): string =>
  lista.find((i) => i.codigo === codigo)?.descripcion ?? "sin descripción"

export const esRetroactiva = (paquete: Paquete): boolean =>
  paquete.factura !== null && soloFecha(paquete.factura.fecha) < soloFecha(paquete.solicitud.fecha_solicitud)

const rc8Retroactiva = ({ paquete }: Contexto, h: Hallazgos): void => {
  const f = paquete.factura
  if (f && esRetroactiva(paquete))
    h.confirmaciones.push({
      codigo: "RC8",
      detalle: `OC retroactiva: la factura ${f.numero} es del ${soloFecha(f.fecha)}, anterior a la solicitud (${paquete.solicitud.fecha_solicitud}). Quedará marcada retroactiva = true en el log de control.`,
      accion_sugerida: "Confirmar la creación de la OC retroactiva (desvío de proceso que se mide).",
      valores: { fecha_factura: soloFecha(f.fecha), fecha_solicitud: paquete.solicitud.fecha_solicitud },
    })
}

const rc9FechaAprobacion = ({ paquete }: Contexto, h: Hallazgos): void => {
  const a = paquete.aprobacion
  if (a && soloFecha(a.fecha) < paquete.solicitud.fecha_solicitud)
    h.confirmaciones.push({
      codigo: "RC9",
      detalle: `La aprobación (${soloFecha(a.fecha)}) es anterior a la fecha de la solicitud (${paquete.solicitud.fecha_solicitud}).`,
      accion_sugerida: "Confirmar que la aprobación corresponde a esta solicitud.",
      valores: { fecha_aprobacion: soloFecha(a.fecha), fecha_solicitud: paquete.solicitud.fecha_solicitud },
    })
}

const rc10Aritmetica = ({ paquete }: Contexto, h: Hallazgos): void => {
  const s = paquete.solicitud
  const calculado = s.cantidad * s.valor_unitario
  if (Math.abs(calculado - s.valor_total) > POLITICA.toleranciaAritmetica)
    h.bloqueos.push({
      codigo: "RC10",
      detalle: `cantidad × valor_unitario = ${formatoMoneda(calculado, s.moneda)} no coincide con valor_total ${formatoMoneda(s.valor_total, s.moneda)}.`,
      accion_sugerida: "Pedir al solicitante que corrija el Excel de solicitud.",
      valores: { calculado, valor_total: s.valor_total },
    })
}

export const validarPaquete = (paquete: Paquete, maestros: Maestros): Validacion => {
  const ctx: Contexto = {
    paquete,
    maestros,
    proveedor: buscarProveedor(paquete, maestros),
    centro: maestros.centrosCosto.find((c) => c.centro_costo === paquete.solicitud.centro_costo) ?? null,
  }
  const h: Hallazgos = { bloqueos: [], confirmaciones: [] }
  const derivados: Derivados = {}
  rc1Proveedor(ctx, h)
  rc2rc3Aprobacion(ctx, h)
  rc4Subarea(ctx, h)
  rc5Cotizacion(ctx, h)
  rc6rc7Derivados(ctx, h, derivados)
  rc8Retroactiva(ctx, h)
  rc9FechaAprobacion(ctx, h)
  rc10Aritmetica(ctx, h)
  return { apta: h.bloqueos.length === 0, ...h, derivados, retroactiva: esRetroactiva(paquete) }
}
