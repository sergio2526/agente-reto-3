import { readFile } from "node:fs/promises"
import { z } from "zod"
import { RUTA_MAESTROS, anexar, existe, rutaOut, rutaSegura } from "../lib/archivos.ts"
import { normalizarNit } from "../lib/texto.ts"
import { ProveedorSchema, type OrdenCompra } from "../tools/tipos.ts"
import type { SapAdapter } from "./adapter.ts"

const PRIMER_NUMERO = 4_500_000_001

const RegistroSchema = z.object({ numero_oc: z.string(), fecha: z.string(), orden: z.object({ referencia: z.object({ solicitud_id: z.string() }) }) })
type Registro = z.infer<typeof RegistroSchema>

/** SAP simulado sobre out/sap/ordenes.jsonl. Numeración secuencial e idempotencia por solicitud_id. */
export class SapMock implements SapAdapter {
  private cola: Promise<unknown> = Promise.resolve()

  constructor(private readonly directorio: string) {}

  private get archivo(): string {
    return rutaOut(this.directorio, "sap", "ordenes.jsonl")
  }

  private async registros(): Promise<Registro[]> {
    if (!(await existe(this.archivo))) return []
    const lineas = (await readFile(this.archivo, "utf8")).split("\n").filter(Boolean)
    return lineas.map((l) => RegistroSchema.parse(JSON.parse(l)))
  }

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const texto = await readFile(rutaSegura(this.directorio, RUTA_MAESTROS, "proveedores.json"), "utf8")
    const p = z.array(ProveedorSchema).parse(JSON.parse(texto)).find((x) => normalizarNit(x.nit) === normalizarNit(nit))
    return p ? { codigo_sap: p.codigo_sap, activo: p.activo } : null
  }

  async buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null> {
    const r = (await this.registros()).find((x) => x.orden.referencia.solicitud_id === solicitud_id)
    return r ? { numero_oc: r.numero_oc } : null
  }

  /** Serializa escrituras para que dos solicitudes simultáneas no tomen el mismo número. */
  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    const tarea = this.cola.then(() => this.crearOrdenSerial(orden))
    this.cola = tarea.catch(() => undefined)
    return tarea
  }

  private async crearOrdenSerial(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    const existentes = await this.registros()
    const previa = existentes.find((x) => x.orden.referencia.solicitud_id === orden.referencia.solicitud_id)
    if (previa) return { numero_oc: previa.numero_oc, fecha: previa.fecha }
    const numero_oc = String(PRIMER_NUMERO + existentes.length)
    const fecha = new Date().toISOString()
    await anexar(this.archivo, JSON.stringify({ numero_oc, fecha, orden }) + "\n")
    return { numero_oc, fecha }
  }
}
