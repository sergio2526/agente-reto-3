/**
 * API HTTP del agente + front estático. Solo orquesta: el comportamiento vive en
 * agent/prompt.md, el conocimiento en src/knowledge/ y la ejecución en src/tools/.
 */
import { timingSafeEqual } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { extname } from "node:path"
import { CicloAgente } from "./agent/ciclo.ts"
import { AlmacenSesiones, idSesionValido } from "./agent/sesiones.ts"
import { config } from "./config.ts"
import { RUTA_SOLICITUDES, existe, rutaSegura } from "./lib/archivos.ts"
import type { ProveedorLLM } from "./llm/adapter.ts"
import { crearProveedor } from "./llm/index.ts"
import { ProveedorSimulado } from "./llm/simulado.ts"
import { herramientas } from "./tools/index.ts"

const iniciarProveedor = (): { proveedor: ProveedorLLM; aviso: string | null } => {
  try {
    return { proveedor: crearProveedor(), aviso: null }
  } catch (e) {
    const aviso = `No se pudo iniciar el proveedor "${config.proveedor}" (${(e as Error).message}). Se usa el modo simulado.`
    console.warn(aviso)
    return { proveedor: new ProveedorSimulado(), aviso }
  }
}

const { proveedor, aviso } = iniciarProveedor()
const sistema = await readFile(rutaSegura(config.directorio, "agent/prompt.md"), "utf8")
const sesiones = new AlmacenSesiones(config.directorio)
const ciclo = new CicloAgente({
  proveedor,
  herramientas,
  sistema,
  directorio: config.directorio,
  maxIteraciones: config.maxIteraciones,
  maxTokensSesion: config.maxTokensSesion,
})

const TIPOS: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".jsonl": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".svg": "image/svg+xml",
}

const json = (cuerpo: unknown, status = 200): Response =>
  new Response(JSON.stringify(cuerpo), { status, headers: { "content-type": "application/json; charset=utf-8" } })

const archivo = async (ruta: string): Promise<Response> =>
  (await existe(ruta))
    ? new Response(Bun.file(ruta), { headers: { "content-type": TIPOS[extname(ruta)] ?? "application/octet-stream" } })
    : json({ ok: false, error: "No encontrado" }, 404)

const autorizado = (req: Request): boolean => {
  if (!config.claveAcceso) return true
  const recibida = Buffer.from(req.headers.get("x-access-key") ?? "")
  const esperada = Buffer.from(config.claveAcceso)
  return recibida.length === esperada.length && timingSafeEqual(recibida, esperada)
}

const leerCuerpo = async (req: Request): Promise<{ sessionId: string; message: string } | string> => {
  const cuerpo: unknown = await req.json().catch(() => null)
  if (typeof cuerpo !== "object" || cuerpo === null) return "El cuerpo debe ser JSON: { sessionId, message }"
  const { sessionId, message } = cuerpo as Record<string, unknown>
  if (typeof sessionId !== "string" || !idSesionValido(sessionId)) return "sessionId inválido (letras, números, - y _; máx. 64)"
  if (typeof message !== "string" || !message.trim()) return "message es obligatorio"
  if (message.length > config.maxCaracteresMensaje) return `El mensaje supera ${config.maxCaracteresMensaje} caracteres`
  return { sessionId, message: message.trim() }
}

const chat = async (req: Request): Promise<Response> => {
  const cuerpo = await leerCuerpo(req)
  if (typeof cuerpo === "string") return json({ ok: false, error: cuerpo }, 400)
  if (!sesiones.tomar(cuerpo.sessionId)) return json({ ok: false, error: "Ya hay un mensaje en proceso en esta sesión." }, 409)
  try {
    const sesion = await sesiones.obtenerOCrear(cuerpo.sessionId)
    const r = await ciclo.turno(sesion, cuerpo.message)
    await sesiones.guardar(sesion)
    return json({ ...r, tokensSesion: sesion.tokens })
  } finally {
    sesiones.soltar(cuerpo.sessionId)
  }
}

const historial = async (id: string): Promise<Response> => {
  if (!idSesionValido(id)) return json({ ok: false, error: "sessionId inválido" }, 400)
  const s = await sesiones.obtener(id)
  return s
    ? json({ id: s.id, creada: s.creada, historial: s.historial, tokens: s.tokens, needsConfirmation: s.pendientes.length > 0 })
    : json({ ok: false, error: "Sesión no encontrada" }, 404)
}

/** Expone los artefactos generados (evidencia, trazabilidad, control) en solo lectura; nunca sesiones ni logs. */
const artefacto = async (ruta: string): Promise<Response> => {
  if (!/^out\/(sap\/ordenes\.jsonl|control\.csv|sol-[\w-]+\/(aprobacion\.(txt|pdf)|trazabilidad\.json))$/.test(ruta))
    return json({ ok: false, error: "Ruta no permitida" }, 403)
  return archivo(rutaSegura(config.directorio, ruta))
}

const servidor = Bun.serve({
  port: config.puerto,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url)
    const ruta = url.pathname
    try {
      if (ruta === "/api/health")
        return json({ ok: true, provider: proveedor.nombre, model: proveedor.modelo, aviso, accesoProtegido: Boolean(config.claveAcceso), herramientas: herramientas.map((h) => h.nombre) })
      if (ruta.startsWith("/api/") && !autorizado(req)) return json({ ok: false, error: "Clave de acceso inválida" }, 401)
      if (ruta === "/api/chat" && req.method === "POST") return await chat(req)
      if (ruta.startsWith("/api/sessions/") && req.method === "GET") return await historial(decodeURIComponent(ruta.slice("/api/sessions/".length)))
      if (ruta === "/api/casos") return json({ casos: (await readdir(rutaSegura(config.directorio, RUTA_SOLICITUDES))).filter((c) => !c.startsWith(".")).sort() })
      if (ruta === "/api/archivo") return await artefacto(url.searchParams.get("ruta") ?? "")
      if (ruta.startsWith("/api/")) return json({ ok: false, error: "Ruta no encontrada" }, 404)
      return await archivo(rutaSegura(rutaSegura(config.directorio, "web"), ruta === "/" ? "index.html" : ruta.slice(1)))
    } catch (e) {
      console.error(`[${req.method} ${ruta}]`, (e as Error).message)
      return json({ ok: false, error: "Error interno del servidor" }, 500)
    }
  },
})

console.log(`Agente OC SAP en http://localhost:${servidor.port} · proveedor: ${proveedor.nombre} · modelo: ${proveedor.modelo}`)
