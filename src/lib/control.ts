import { anexar, existe, rutaOut } from "./archivos.ts"

export type ResultadoControl = "exitoso" | "idempotente" | "bloqueado" | "pendiente" | "error"

export type FilaControl = {
  solicitud_id: string
  resultado: ResultadoControl
  numero_oc: string | null
  retroactiva: boolean
  bloqueos: string[]
  confirmaciones: string[]
}

const COLUMNAS = ["solicitud_id", "resultado", "numero_oc", "retroactiva", "bloqueos", "confirmaciones", "ts"] as const

const csv = (valor: string): string => (/[",\n]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor)

/** Agrega una fila a out/control.csv (HU-5). Crea el encabezado la primera vez. */
export const registrarControl = async (directorio: string, fila: FilaControl): Promise<void> => {
  const ruta = rutaOut(directorio, "control.csv")
  if (!(await existe(ruta))) await anexar(ruta, COLUMNAS.join(",") + "\n")
  const valores = [
    fila.solicitud_id,
    fila.resultado,
    fila.numero_oc ?? "",
    String(fila.retroactiva),
    fila.bloqueos.join("|"),
    fila.confirmaciones.join("|"),
    new Date().toISOString(),
  ]
  await anexar(ruta, valores.map(csv).join(",") + "\n")
}
