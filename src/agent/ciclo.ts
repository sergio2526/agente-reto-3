/**
 * Ciclo del agente: prompt → modelo → herramientas → modelo … → respuesta.
 * Reglas CA1–CA5 del PRD: tope de iteraciones, confirmación humana obligatoria
 * para crear con excepciones, toda llamada visible y registrada, errores legibles.
 */
import { anexar, rutaOut } from "../lib/archivos.ts"
import { ErrorProveedor, type DefinicionHerramienta, type Mensaje, type ProveedorLLM, type ResultadoHerramienta } from "../llm/adapter.ts"
import type { HerramientaRegistrada } from "../tools/index.ts"
import { esConfirmacion } from "./confirmacion.ts"
import type { Evento, EventoHerramienta, Sesion } from "./sesiones.ts"

export type ConfigCiclo = {
  proveedor: ProveedorLLM
  herramientas: HerramientaRegistrada[]
  sistema: string
  directorio: string
  maxIteraciones: number
  maxTokensSesion: number
}

export type RespuestaTurno = { reply: string; toolCalls: EventoHerramienta[]; needsConfirmation: boolean; error?: string }

const ahora = (): string => new Date().toISOString()
const MAX_VISIBLE = 4_000

type Salida = { ok?: boolean; data?: Record<string, unknown>; error?: string; requiere_confirmacion?: boolean }

const leerSalida = (json: string): Salida => {
  try {
    return JSON.parse(json) as Salida
  } catch {
    return { ok: false, error: "salida no JSON" }
  }
}

const casoDe = (argumentos: unknown): string | null =>
  typeof argumentos === "object" && argumentos !== null && "caso" in argumentos && typeof argumentos.caso === "string" ? argumentos.caso : null

/** Resumen de una línea para el chat. */
const resumir = (nombre: string, s: Salida): string => {
  if (!s.ok) return `✗ ${s.error ?? "error"}`
  const d = s.data ?? {}
  const codigos = (x: unknown): string => (Array.isArray(x) ? x.map((h: { codigo?: string }) => h.codigo).join(", ") || "ninguno" : "—")
  switch (nombre) {
    case "oc_leer_paquete":
      return `Paquete leído${Array.isArray(d.faltantes) && d.faltantes.length ? ` · faltan: ${d.faltantes.join(", ")}` : " · completo"}`
    case "oc_validar":
      return `apta: ${String(d.apta)} · bloqueos: ${codigos(d.bloqueos)} · confirmaciones: ${codigos(d.confirmaciones)} · retroactiva: ${String(d.retroactiva)}`
    case "oc_construir_payload":
      return `Payload válido · trazabilidad en ${String(d.trazabilidad)}`
    case "oc_generar_evidencia":
      return `Evidencia ${String(d.ruta)} · sha256 ${String(d.sha256).slice(0, 12)}…`
    case "oc_crear":
      return `OC ${String(d.numero_oc)}${d.idempotente ? " (ya existía)" : " creada"}`
    default:
      return "ok"
  }
}

const esConfirmadoTrue = (argumentos: unknown): boolean =>
  typeof argumentos === "object" && argumentos !== null && "confirmado" in argumentos && argumentos.confirmado === true

const sinConfirmado = (argumentos: unknown): unknown => {
  if (typeof argumentos !== "object" || argumentos === null) return argumentos
  const { confirmado: _ignorado, ...resto } = argumentos as Record<string, unknown>
  return resto
}

const recortar = (texto: string): string => (texto.length > MAX_VISIBLE ? `${texto.slice(0, MAX_VISIBLE)}… (recortado)` : texto)

export class CicloAgente {
  constructor(private readonly config: ConfigCiclo) {}

  private get definiciones(): DefinicionHerramienta[] {
    return this.config.herramientas.map(({ nombre, descripcion, esquema }) => ({ nombre, descripcion, esquema }))
  }

  async turno(sesion: Sesion, texto: string): Promise<RespuestaTurno> {
    const llamadas: EventoHerramienta[] = []
    sesion.historial.push({ tipo: "usuario", texto, ts: ahora() })

    if (sesion.tokens >= this.config.maxTokensSesion)
      return this.cerrarConError(sesion, llamadas, "Esta sesión alcanzó su tope de tokens. Abre una sesión nueva para continuar.")

    // CA3: solo el mensaje inmediatamente siguiente a la pregunta puede confirmar.
    const confirmados = new Set(esConfirmacion(texto) ? sesion.pendientes : [])
    sesion.pendientes = []
    agregarTextoUsuario(sesion.mensajes, texto)

    try {
      for (let iteracion = 1; iteracion <= this.config.maxIteraciones; iteracion++) {
        const r = await this.config.proveedor.enviar(sesion.mensajes, this.definiciones, { sistema: this.config.sistema })
        sesion.mensajes.push(r.mensaje)
        sesion.tokens += r.uso.entrada + r.uso.salida

        if (r.motivo !== "herramientas") {
          // Una respuesta cortada puede traer llamadas sin ejecutar: se cierran para mantener la conversación válida.
          const huerfanas = r.mensaje.contenido.flatMap((b): ResultadoHerramienta[] =>
            b.tipo === "llamada" ? [{ tipo: "resultado", id: b.id, contenido: '{"ok":false,"error":"no ejecutada"}', esError: true }] : [],
          )
          if (huerfanas.length) sesion.mensajes.push({ rol: "usuario", contenido: huerfanas })
          return this.cerrar(sesion, llamadas, textoDe(r.mensaje.contenido), r.motivo)
        }

        const resultados: ResultadoHerramienta[] = []
        for (const b of r.mensaje.contenido) {
          if (b.tipo !== "llamada") continue
          const evento = await this.ejecutar(sesion, b.id, b.nombre, b.argumentos, confirmados)
          llamadas.push(evento)
          sesion.historial.push(evento)
          resultados.push({ tipo: "resultado", id: b.id, contenido: evento.resultado, esError: !evento.ok })
        }
        sesion.mensajes.push({ rol: "usuario", contenido: resultados })
      }
      return await this.cierrePorTope(sesion, llamadas)
    } catch (e) {
      const mensaje = e instanceof ErrorProveedor ? e.message : `Error inesperado del agente: ${(e as Error).message}`
      return this.cerrarConError(sesion, llamadas, mensaje)
    }
  }

  /** CA1: al alcanzar el tope, una última llamada sin herramientas para responder con lo que hay y lo que falta. */
  private async cierrePorTope(sesion: Sesion, llamadas: EventoHerramienta[]): Promise<RespuestaTurno> {
    agregarTextoUsuario(
      sesion.mensajes,
      `[Aviso del sistema] Se alcanzó el tope de ${this.config.maxIteraciones} iteraciones de herramientas en este turno. Sin llamar más herramientas, resume lo que lograste y lo que falta.`,
    )
    const r = await this.config.proveedor.enviar(sesion.mensajes, this.definiciones, { sistema: this.config.sistema, permitirHerramientas: false })
    sesion.mensajes.push(r.mensaje)
    sesion.tokens += r.uso.entrada + r.uso.salida
    return this.cerrar(sesion, llamadas, textoDe(r.mensaje.contenido) || "Alcancé el tope de iteraciones de este turno.", "fin")
  }

  private async ejecutar(sesion: Sesion, id: string, nombre: string, argumentos: unknown, confirmados: Set<string>): Promise<EventoHerramienta> {
    const inicio = performance.now()
    const herramienta = this.config.herramientas.find((h) => h.nombre === nombre)
    const caso = casoDe(argumentos)
    // CA3: un `confirmado: true` sin confirmación humana en el último mensaje se ignora (no se rechaza):
    // la herramienta decide si el caso la necesita y, si la necesita, lo deja pendiente.
    const confirmacionSinAutorizar = nombre === "oc_crear" && esConfirmadoTrue(argumentos) && !(caso !== null && confirmados.has(caso))
    const efectivos = confirmacionSinAutorizar ? sinConfirmado(argumentos) : argumentos

    const crudo = herramienta
      ? await herramienta.ejecutar(efectivos, { directory: this.config.directorio, sessionId: sesion.id })
      : JSON.stringify({ ok: false, error: `La herramienta ${nombre} no existe.` })
    const resultado =
      confirmacionSinAutorizar && leerSalida(crudo).requiere_confirmacion
        ? JSON.stringify({
            ...leerSalida(crudo),
            aviso: `confirmado=true se ignoró: el usuario no confirmó ${caso ?? "este caso"} en respuesta a una pregunta tuya. Termina el turno preguntando.`,
          })
        : crudo

    const salida = leerSalida(resultado)
    if (caso) this.actualizarPendientes(sesion, nombre, caso, salida)
    const evento: EventoHerramienta = {
      tipo: "herramienta",
      id,
      nombre,
      argumentos,
      ok: salida.ok === true,
      resumen: resumir(nombre, salida),
      resultado,
      ms: Math.round(performance.now() - inicio),
      ts: ahora(),
    }
    await this.registrar(sesion.id, evento)
    return evento
  }

  private actualizarPendientes(sesion: Sesion, nombre: string, caso: string, s: Salida): void {
    const quitar = () => (sesion.pendientes = sesion.pendientes.filter((c) => c !== caso))
    const agregar = () => {
      if (!sesion.pendientes.includes(caso)) sesion.pendientes.push(caso)
    }
    if (nombre === "oc_validar" && s.ok) {
      const conConfirmaciones = s.data?.apta === true && Array.isArray(s.data.confirmaciones) && s.data.confirmaciones.length > 0
      if (conConfirmaciones) agregar()
      else quitar()
    }
    if (nombre === "oc_crear") {
      if (s.ok) quitar()
      else if (s.requiere_confirmacion) agregar()
    }
  }

  /** CA4: cada llamada queda en out/log.jsonl. */
  private async registrar(sessionId: string, e: EventoHerramienta): Promise<void> {
    const linea = { ts: e.ts, sessionId, herramienta: e.nombre, argumentos: recortar(JSON.stringify(e.argumentos)), ok: e.ok, resumen: e.resumen, ms: e.ms }
    await anexar(rutaOut(this.config.directorio, "log.jsonl"), JSON.stringify(linea) + "\n").catch(() => undefined)
  }

  private cerrar(sesion: Sesion, llamadas: EventoHerramienta[], texto: string, motivo: string): RespuestaTurno {
    const aviso =
      motivo === "rechazo"
        ? "\n\n_El modelo declinó responder esta solicitud._"
        : motivo === "limite_salida"
          ? "\n\n_La respuesta se cortó por longitud; pide que continúe._"
          : ""
    const reply = (texto || "(sin texto)") + aviso
    const needsConfirmation = sesion.pendientes.length > 0
    const evento: Evento = { tipo: "agente", texto: reply, pideConfirmacion: needsConfirmation, ts: ahora() }
    sesion.historial.push(evento)
    return { reply, toolCalls: llamadas, needsConfirmation }
  }

  /** CA5: el error se muestra en lenguaje claro y la sesión sigue viva. */
  private cerrarConError(sesion: Sesion, llamadas: EventoHerramienta[], mensaje: string): RespuestaTurno {
    sesion.historial.push({ tipo: "error", texto: mensaje, ts: ahora() })
    return { reply: mensaje, toolCalls: llamadas, needsConfirmation: false, error: mensaje }
  }
}

const textoDe = (contenido: Mensaje["contenido"]): string =>
  contenido.flatMap((b) => (b.tipo === "texto" ? [b.texto] : [])).join("\n\n").trim()

/**
 * Agrega texto del usuario. Si el último mensaje ya es del usuario (p. ej. el turno
 * anterior se cortó por un error tras ejecutar herramientas), se anexa a ese mensaje
 * para no romper la alternancia de roles ni reescribir historia previa.
 */
const agregarTextoUsuario = (mensajes: Mensaje[], texto: string): void => {
  const ultimo = mensajes.at(-1)
  if (ultimo?.rol === "usuario") ultimo.contenido.push({ tipo: "texto", texto })
  else mensajes.push({ rol: "usuario", contenido: [{ tipo: "texto", texto }] })
}
