/**
 * Interfaz propia del proveedor LLM. El ciclo del agente solo conoce estos tipos;
 * cambiar de proveedor = escribir otra implementación de `ProveedorLLM`.
 */

export type BloqueTexto = { tipo: "texto"; texto: string }
export type LlamadaHerramienta = { tipo: "llamada"; id: string; nombre: string; argumentos: unknown }
export type ResultadoHerramienta = { tipo: "resultado"; id: string; contenido: string; esError: boolean }

export type MensajeUsuario = { rol: "usuario"; contenido: Array<BloqueTexto | ResultadoHerramienta> }
export type MensajeAsistente = {
  rol: "asistente"
  contenido: Array<BloqueTexto | LlamadaHerramienta>
  /** Contenido nativo del proveedor (p. ej. bloques de razonamiento) que debe reenviarse sin cambios. */
  nativo?: unknown
}
export type Mensaje = MensajeUsuario | MensajeAsistente

export type DefinicionHerramienta = { nombre: string; descripcion: string; esquema: Record<string, unknown> }

export type Respuesta = {
  mensaje: MensajeAsistente
  motivo: "fin" | "herramientas" | "limite_salida" | "rechazo"
  uso: { entrada: number; salida: number }
}

export type OpcionesEnvio = { sistema: string; permitirHerramientas?: boolean }

export interface ProveedorLLM {
  readonly nombre: string
  readonly modelo: string
  enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[], opciones: OpcionesEnvio): Promise<Respuesta>
}

/** Error del proveedor con mensaje apto para mostrar al usuario (nunca incluye claves). */
export class ErrorProveedor extends Error {
  constructor(
    mensaje: string,
    readonly reintentable: boolean,
  ) {
    super(mensaje)
  }
}
