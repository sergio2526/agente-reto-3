import { readFile } from "node:fs/promises"
import { escribir, existe, rutaOut } from "../lib/archivos.ts"
import type { Mensaje } from "../llm/adapter.ts"

export type EventoHerramienta = {
  tipo: "herramienta"
  id: string
  nombre: string
  argumentos: unknown
  ok: boolean
  resumen: string
  resultado: string
  ms: number
  ts: string
}

export type Evento =
  | { tipo: "usuario"; texto: string; ts: string }
  | { tipo: "agente"; texto: string; pideConfirmacion: boolean; ts: string }
  | { tipo: "error"; texto: string; ts: string }
  | EventoHerramienta

export type Sesion = {
  id: string
  creada: string
  /** Conversación tal como la ve el modelo (append-only). */
  mensajes: Mensaje[]
  /** Conversación tal como la ve el humano en el chat. */
  historial: Evento[]
  tokens: number
  /** Casos cuya creación espera confirmación humana en el siguiente mensaje. */
  pendientes: string[]
}

export const idSesionValido = (id: string): boolean => /^[A-Za-z0-9_-]{1,64}$/.test(id)

const MAX_EN_MEMORIA = 200

/** Sesiones en memoria con respaldo en out/sesiones/<id>.json (sobreviven a reinicios). */
export class AlmacenSesiones {
  private readonly sesiones = new Map<string, Sesion>()
  private readonly ocupadas = new Set<string>()

  constructor(private readonly directorio: string) {}

  private ruta(id: string): string {
    return rutaOut(this.directorio, "sesiones", `${id}.json`)
  }

  async obtener(id: string): Promise<Sesion | null> {
    const enMemoria = this.sesiones.get(id)
    if (enMemoria) return enMemoria
    if (!(await existe(this.ruta(id)))) return null
    const sesion = JSON.parse(await readFile(this.ruta(id), "utf8")) as Sesion
    this.recordar(sesion)
    return sesion
  }

  async obtenerOCrear(id: string): Promise<Sesion> {
    const existente = await this.obtener(id)
    if (existente) return existente
    const nueva: Sesion = { id, creada: new Date().toISOString(), mensajes: [], historial: [], tokens: 0, pendientes: [] }
    this.recordar(nueva)
    return nueva
  }

  async guardar(sesion: Sesion): Promise<void> {
    await escribir(this.ruta(sesion.id), JSON.stringify(sesion))
  }

  /** Evita dos turnos simultáneos sobre la misma sesión. */
  tomar(id: string): boolean {
    if (this.ocupadas.has(id)) return false
    this.ocupadas.add(id)
    return true
  }

  soltar(id: string): void {
    this.ocupadas.delete(id)
  }

  private recordar(sesion: Sesion): void {
    this.sesiones.set(sesion.id, sesion)
    if (this.sesiones.size > MAX_EN_MEMORIA) {
      const masAntigua = this.sesiones.keys().next().value
      if (masAntigua !== undefined) this.sesiones.delete(masAntigua)
    }
  }
}
