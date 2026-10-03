import type { OrdenCompra } from "../tools/tipos.ts"

export type { OrdenCompra }

/** Puerto hacia SAP (PRD 7.4). La implementación real se diseña en SOLUCION.md §6. */
export interface SapAdapter {
  consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null>
  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }>
  buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null>
}
