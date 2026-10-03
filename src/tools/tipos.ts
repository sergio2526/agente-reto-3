import { z } from "zod"

// ── Contrato de herramientas (PRD 6.2) ────────────────────────────────────────

export type ContextoHerramienta = { directory: string; sessionId: string }

export type Herramienta<S extends z.ZodRawShape> = {
  description: string
  args: S
  execute(args: z.infer<z.ZodObject<S>>, ctx: ContextoHerramienta): Promise<string>
}

/** Ayuda de tipado: conserva la inferencia de `args` en cada herramienta. */
export const herramienta = <S extends z.ZodRawShape>(h: Herramienta<S>): Herramienta<S> => h

export type Resultado<T> = { ok: true; data: T } | { ok: false; error: string; [extra: string]: unknown }

export const ok = <T>(data: T): string => JSON.stringify({ ok: true, data })
export const fallo = (error: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ ok: false, error, ...extra })

// ── Fixtures (PRD 7.1) ───────────────────────────────────────────────────────

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}/, "fecha ISO (AAAA-MM-DD)")
const monto = (campo: string) =>
  z.number({ error: `${campo} debe ser numérico` }).finite().nonnegative(`${campo} no puede ser negativo`)

export const SolicitudSchema = z.object({
  solicitud_id: z.string().min(1),
  solicitante: z.string().min(1),
  proveedor_nombre: z.string().min(1),
  proveedor_nit: z.string().optional(),
  descripcion: z.string().min(1),
  centro_costo: z.string().min(1),
  subarea: z.string().min(1),
  cantidad: monto("cantidad").positive("cantidad debe ser mayor a 0"),
  valor_unitario: monto("valor_unitario"),
  valor_total: monto("valor_total").positive("valor_total debe ser mayor a 0"),
  moneda: z.enum(["COP", "USD"]),
  indicador_iva: z.string().optional(),
  condiciones_pago: z.string().optional(),
  fecha_solicitud: fecha,
})
export type Solicitud = z.infer<typeof SolicitudSchema>

export const CorreoFixtureSchema = z.object({
  id: z.string(),
  de: z.string(),
  asunto: z.string(),
  fecha: z.string(),
  cuerpo: z.string().optional(),
  adjuntos: z.array(z.string()).optional(),
})

export const AprobacionFixtureSchema = z.object({
  de: z.string(),
  para: z.string(),
  fecha: z.string(),
  asunto: z.string(),
  cuerpo: z.string(),
  cc: z.array(z.string()).optional(),
})
export type AprobacionFixture = z.infer<typeof AprobacionFixtureSchema>

export const ProveedorSchema = z.object({
  codigo_sap: z.string(),
  nit: z.string(),
  nombre: z.string(),
  condiciones_pago_default: z.string(),
  indicador_iva_default: z.string(),
  activo: z.boolean(),
})
export type Proveedor = z.infer<typeof ProveedorSchema>

export const CentroCostoSchema = z.object({
  centro_costo: z.string(),
  nombre: z.string().optional(),
  subareas: z.array(z.string()),
  aprobadores: z.array(z.object({ email: z.string(), nombre: z.string().optional(), tope: z.number() })),
})
export type CentroCosto = z.infer<typeof CentroCostoSchema>

export const CodigoMaestroSchema = z.object({
  codigo: z.string(),
  descripcion: z.string(),
  tasa: z.number().optional(),
  dias: z.number().optional(),
})

export type Maestros = {
  proveedores: Proveedor[]
  centrosCosto: CentroCosto[]
  indicadoresIva: z.infer<typeof CodigoMaestroSchema>[]
  condicionesPago: z.infer<typeof CodigoMaestroSchema>[]
}

// ── Paquete normalizado (PRD 7.2) ────────────────────────────────────────────

export const PaqueteSchema = z.object({
  correo: z.object({ id: z.string(), de: z.string(), asunto: z.string(), fecha: z.string() }),
  solicitud: SolicitudSchema,
  cotizacion: z
    .object({
      referencia: z.string().nullable(),
      proveedor: z.string(),
      nit: z.string().nullable(),
      total: z.number(),
      moneda: z.string(),
      validez_hasta: z.string().nullable(),
      item: z.string().nullable(),
      texto: z.string(),
    })
    .nullable(),
  aprobacion: z
    .object({ de: z.string(), fecha: z.string(), aprobado: z.boolean(), texto: z.string() })
    .nullable(),
  factura: z.object({ numero: z.string(), fecha: z.string(), total: z.number() }).nullable(),
})
export type Paquete = z.infer<typeof PaqueteSchema>

// ── Resultado de validación (HU-2) ───────────────────────────────────────────

export type Hallazgo = {
  codigo: string
  detalle: string
  accion_sugerida: string
  valores?: Record<string, string | number | null>
}

export const DerivadosSchema = z.object({
  indicador_iva: z.object({ valor: z.string(), fuente: z.string() }).optional(),
  condiciones_pago: z.object({ valor: z.string(), fuente: z.string() }).optional(),
})
export type Derivados = z.infer<typeof DerivadosSchema>

export type Validacion = {
  apta: boolean
  bloqueos: Hallazgo[]
  confirmaciones: Hallazgo[]
  derivados: Derivados
  retroactiva: boolean
}

// ── Orden de compra (PRD 7.4) ────────────────────────────────────────────────

export const OrdenCompraSchema = z.object({
  referencia: z.object({
    solicitud_id: z.string(),
    correo_id: z.string(),
    cotizacion_ref: z.string().nullable(),
  }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({ codigo_sap: z.string(), nit: z.string(), nombre: z.string() }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string(),
  aprobador: z.object({
    email: z.string(),
    fecha_aprobacion: z.string(),
    evidencia_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  posiciones: z
    .array(
      z.object({
        numero: z.number().int().positive(),
        descripcion: z.string().max(40),
        cantidad: z.number().positive(),
        unidad: z.enum(["UN", "H", "MES"]),
        precio_unitario: z.number().nonnegative(),
        centro_costo: z.string(),
        subarea: z.string(),
        indicador_iva: z.string(),
      }),
    )
    .min(1),
  excepciones: z.array(
    z.object({ codigo: z.string(), detalle: z.string(), confirmado_por: z.string().nullable() }),
  ),
})
export type OrdenCompra = z.infer<typeof OrdenCompraSchema>
