import Anthropic from "@anthropic-ai/sdk"
import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaTool,
} from "@anthropic-ai/sdk/resources/beta/messages/messages"
import {
  ErrorProveedor,
  type DefinicionHerramienta,
  type Mensaje,
  type MensajeAsistente,
  type OpcionesEnvio,
  type ProveedorLLM,
  type Respuesta,
} from "./adapter.ts"

type Esfuerzo = "low" | "medium" | "high" | "xhigh" | "max"
const ESFUERZOS: readonly Esfuerzo[] = ["low", "medium", "high", "xhigh", "max"]

type Config = { modelo: string; esfuerzo: string; timeoutMs: number }

/** Implementación de ProveedorLLM sobre la API de Claude (Anthropic). */
export class ProveedorAnthropic implements ProveedorLLM {
  readonly nombre = "anthropic"
  readonly modelo: string
  private readonly cliente: Anthropic
  private readonly esfuerzo: Esfuerzo

  constructor(config: Config) {
    // La clave se lee del entorno (ANTHROPIC_API_KEY) dentro del SDK; nunca pasa por este código.
    this.cliente = new Anthropic({ timeout: config.timeoutMs, maxRetries: 2 })
    this.modelo = config.modelo
    this.esfuerzo = ESFUERZOS.find((e) => e === config.esfuerzo) ?? "medium"
  }

  async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[], opciones: OpcionesEnvio): Promise<Respuesta> {
    try {
      const r = await this.cliente.beta.messages.create({
        model: this.modelo,
        max_tokens: 16_000,
        system: opciones.sistema,
        messages: mensajes.map(aAnthropic),
        tools: herramientas.map(aHerramienta),
        tool_choice: { type: opciones.permitirHerramientas === false ? "none" : "auto" },
        output_config: { effort: this.esfuerzo },
        cache_control: { type: "ephemeral" },
        // Si el modelo declina por política, la API reintenta con un modelo alterno dentro de la misma llamada.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      })
      const mensaje: MensajeAsistente = {
        rol: "asistente",
        nativo: r.content,
        contenido: r.content.flatMap((b): MensajeAsistente["contenido"] => {
          if (b.type === "text") return [{ tipo: "texto", texto: b.text }]
          if (b.type === "tool_use") return [{ tipo: "llamada", id: b.id, nombre: b.name, argumentos: b.input }]
          return []
        }),
      }
      return { mensaje, motivo: motivo(r.stop_reason), uso: { entrada: totalEntrada(r.usage), salida: r.usage.output_tokens } }
    } catch (e) {
      throw traducirError(e)
    }
  }
}

const totalEntrada = (u: { input_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): number =>
  u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)

const motivo = (stop: string | null): Respuesta["motivo"] =>
  stop === "tool_use" ? "herramientas" : stop === "max_tokens" ? "limite_salida" : stop === "refusal" ? "rechazo" : "fin"

const aHerramienta = (h: DefinicionHerramienta): BetaTool => ({
  name: h.nombre,
  description: h.descripcion,
  input_schema: { type: "object", ...h.esquema },
})

const aAnthropic = (m: Mensaje): BetaMessageParam => {
  if (m.rol === "asistente") {
    // Se reenvía el contenido nativo sin cambios (incluye bloques de razonamiento del modelo).
    if (Array.isArray(m.nativo)) return { role: "assistant", content: m.nativo as BetaContentBlockParam[] }
    return {
      role: "assistant",
      content: m.contenido.map((b): BetaContentBlockParam =>
        b.tipo === "texto"
          ? { type: "text", text: b.texto }
          : { type: "tool_use", id: b.id, name: b.nombre, input: b.argumentos },
      ),
    }
  }
  return {
    role: "user",
    content: m.contenido.map((b): BetaContentBlockParam =>
      b.tipo === "texto"
        ? { type: "text", text: b.texto }
        : { type: "tool_result", tool_use_id: b.id, content: b.contenido, is_error: b.esError },
    ),
  }
}

const traducirError = (e: unknown): ErrorProveedor => {
  if (e instanceof Anthropic.APIConnectionTimeoutError)
    return new ErrorProveedor("El modelo no respondió a tiempo. Intenta de nuevo en un momento.", true)
  if (e instanceof Anthropic.AuthenticationError)
    return new ErrorProveedor("El backend no tiene una clave válida del proveedor de IA. Revisa la configuración del servidor.", false)
  if (e instanceof Anthropic.PermissionDeniedError)
    return new ErrorProveedor("La clave configurada no tiene permiso para usar este modelo.", false)
  if (e instanceof Anthropic.RateLimitError)
    return new ErrorProveedor("El proveedor de IA está limitando las solicitudes. Espera unos segundos y reintenta.", true)
  if (e instanceof Anthropic.BadRequestError)
    return new ErrorProveedor(`El proveedor de IA rechazó la solicitud: ${e.message}`, false)
  if (e instanceof Anthropic.InternalServerError)
    return new ErrorProveedor("El proveedor de IA tuvo un error interno. Reintenta en un momento.", true)
  if (e instanceof Anthropic.APIConnectionError)
    return new ErrorProveedor("No fue posible conectar con el proveedor de IA. Revisa la conexión del servidor.", true)
  if (e instanceof Anthropic.APIError) return new ErrorProveedor(`Error del proveedor de IA (${e.status ?? "?"}).`, true)
  return new ErrorProveedor(`Error inesperado al llamar al modelo: ${(e as Error).message}`, false)
}
