// Front de chat sin dependencias. Nunca recibe ni guarda claves del proveedor de IA.
const $ = (id) => document.getElementById(id)
const mensajes = $("mensajes")
const texto = $("texto")
const enviar = $("enviar")
const confirmacion = $("confirmacion")

const leer = (almacen, clave) => { try { return almacen.getItem(clave) } catch { return null } }
const guardar = (almacen, clave, valor) => { try { almacen.setItem(clave, valor) } catch { /* sin almacenamiento */ } }

let sessionId = leer(localStorage, "oc.sesion") || nuevaSesionId()
let ocupado = false

function nuevaSesionId() {
  const id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  guardar(localStorage, "oc.sesion", id)
  return id
}

// ── API ──────────────────────────────────────────────────────────────────────
async function api(ruta, opciones = {}) {
  const clave = leer(sessionStorage, "oc.acceso")
  const headers = { "content-type": "application/json", ...(clave ? { "x-access-key": clave } : {}) }
  const r = await fetch(ruta, { ...opciones, headers })
  if (r.status === 401) {
    const nueva = prompt("Esta demo está protegida. Ingresa la clave de acceso:")
    if (nueva) { guardar(sessionStorage, "oc.acceso", nueva); return api(ruta, opciones) }
  }
  const cuerpo = await r.json().catch(() => ({ ok: false, error: `Respuesta inválida (${r.status})` }))
  return { status: r.status, cuerpo }
}

// ── Markdown mínimo (escapa HTML primero) ────────────────────────────────────
const escapar = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
const RUTA_ARTEFACTO = /^out\/(sap\/ordenes\.jsonl|control\.csv|sol-[\w-]+\/(aprobacion\.(txt|pdf)|trazabilidad\.json))$/

function enLinea(s) {
  return escapar(s)
    .replace(/`([^`]+)`/g, (_, c) => RUTA_ARTEFACTO.test(c)
      ? `<a href="/api/archivo?ruta=${encodeURIComponent(c)}" target="_blank" rel="noopener"><code>${c}</code></a>`
      : `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/(^|\s)_([^_]+)_(?=\s|$|[.,])/g, "$1<em>$2</em>")
}

function markdown(md) {
  const lineas = md.replace(/\r/g, "").split("\n")
  const html = []
  let i = 0
  while (i < lineas.length) {
    const l = lineas[i]
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|?\s*:?-{2,}/.test(lineas[i + 1] || "")) {
      const celdas = (x) => x.trim().replace(/^\||\|$/g, "").split("|").map((c) => enLinea(c.trim()))
      const cab = celdas(l)
      i += 2
      const filas = []
      while (i < lineas.length && /^\s*\|.*\|\s*$/.test(lineas[i])) filas.push(celdas(lineas[i++]))
      html.push(`<table><thead><tr>${cab.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${filas.map((f) => `<tr>${f.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`)
      continue
    }
    const titulo = l.match(/^(#{1,6})\s+(.*)$/)
    if (titulo) { html.push(`<h${titulo[1].length <= 3 ? 3 : 4}>${enLinea(titulo[2])}</h${titulo[1].length <= 3 ? 3 : 4}>`); i++; continue }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const items = []
      while (i < lineas.length && /^\s*([-*]|\d+\.)\s+/.test(lineas[i])) {
        const sangria = lineas[i].match(/^\s*/)[0].length
        items.push(`<li${sangria >= 2 ? ' style="margin-left:16px"' : ""}>${enLinea(lineas[i].replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>`)
        i++
      }
      html.push(`<ul>${items.join("")}</ul>`)
      continue
    }
    if (!l.trim()) { i++; continue }
    const parrafo = []
    while (i < lineas.length && lineas[i].trim() && !/^(#{1,6}\s|\s*([-*]|\d+\.)\s|\s*\|)/.test(lineas[i])) parrafo.push(enLinea(lineas[i++]))
    if (!parrafo.length) { parrafo.push(enLinea(lineas[i++])) }
    html.push(`<p>${parrafo.join("<br>")}</p>`)
  }
  return html.join("")
}

// ── Render ───────────────────────────────────────────────────────────────────
function agregar(nodo) {
  mensajes.append(nodo)
  mensajes.scrollTop = mensajes.scrollHeight
  return nodo
}

function burbuja(clase, html) {
  const div = document.createElement("div")
  div.className = `msg ${clase}`
  div.innerHTML = html
  return agregar(div)
}

const bonito = (valor) => {
  try { return JSON.stringify(typeof valor === "string" ? JSON.parse(valor) : valor, null, 2) } catch { return String(valor) }
}

function tarjetaHerramienta(e) {
  const d = document.createElement("details")
  d.className = "tool"
  d.innerHTML = `
    <summary>
      <span>🔧</span><span class="nombre">${escapar(e.nombre)}</span>
      <span class="${e.ok ? "estado-ok" : "estado-mal"}">${e.ok ? "✓" : "✗"}</span>
      <span class="resumen">${escapar(e.resumen)}</span>
      <span class="ms">${e.ms} ms</span>
    </summary>
    <h5>Argumentos</h5><pre>${escapar(bonito(e.argumentos))}</pre>
    <h5>Resultado</h5><pre>${escapar(bonito(e.resultado))}</pre>`
  return agregar(d)
}

function renderEvento(e) {
  if (e.tipo === "usuario") return burbuja("usuario", escapar(e.texto))
  if (e.tipo === "herramienta") return tarjetaHerramienta(e)
  if (e.tipo === "error") return burbuja("error", `⚠️ ${escapar(e.texto)}`)
  const aviso = e.pideConfirmacion ? `<span class="etiqueta-confirmacion">⏸ Requiere tu confirmación</span>` : ""
  return burbuja(`agente${e.pideConfirmacion ? " pide" : ""}`, aviso + markdown(e.texto))
}

function pedirConfirmacion(activo) {
  confirmacion.hidden = !activo
}

// ── Envío ────────────────────────────────────────────────────────────────────
async function mandar(mensaje) {
  if (ocupado || !mensaje.trim()) return
  ocupado = true
  enviar.disabled = true
  pedirConfirmacion(false)
  renderEvento({ tipo: "usuario", texto: mensaje })
  texto.value = ""
  const pensando = agregar(Object.assign(document.createElement("div"), { className: "pensando", textContent: "El agente está trabajando…" }))
  try {
    const { cuerpo } = await api("/api/chat", { method: "POST", body: JSON.stringify({ sessionId, message: mensaje }) })
    pensando.remove()
    if (cuerpo.ok === false) { renderEvento({ tipo: "error", texto: cuerpo.error }); return }
    for (const t of cuerpo.toolCalls) renderEvento({ tipo: "herramienta", ...t })
    renderEvento(cuerpo.error ? { tipo: "error", texto: cuerpo.reply } : { tipo: "agente", texto: cuerpo.reply, pideConfirmacion: cuerpo.needsConfirmation })
    pedirConfirmacion(cuerpo.needsConfirmation)
  } catch (err) {
    pensando.remove()
    renderEvento({ tipo: "error", texto: `No fue posible contactar al servidor: ${err.message}` })
  } finally {
    ocupado = false
    enviar.disabled = false
    texto.focus()
  }
}

$("formulario").addEventListener("submit", (ev) => { ev.preventDefault(); mandar(texto.value) })
texto.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); mandar(texto.value) }
})
$("confirmar").addEventListener("click", () => mandar("Confirmo, crea la OC."))
$("rechazar").addEventListener("click", () => mandar("No, no la crees por ahora."))
document.querySelectorAll(".ejemplo").forEach((b) => b.addEventListener("click", () => mandar(b.dataset.texto)))
$("nueva").addEventListener("click", () => {
  sessionId = nuevaSesionId()
  $("sesion").textContent = sessionId
  mensajes.querySelectorAll(".msg, .tool, .pensando").forEach((n) => n.remove())
  pedirConfirmacion(false)
})

// ── Arranque ─────────────────────────────────────────────────────────────────
async function iniciar() {
  $("sesion").textContent = sessionId
  const salud = $("salud")
  try {
    const { cuerpo } = await api("/api/health")
    salud.textContent = `${cuerpo.provider} · ${cuerpo.model}`
    if (cuerpo.aviso) { salud.classList.add("mal"); salud.title = cuerpo.aviso }
  } catch {
    salud.textContent = "sin conexión"
    salud.classList.add("mal")
  }
  const { cuerpo: casos } = await api("/api/casos")
  for (const c of casos.casos || []) {
    const b = Object.assign(document.createElement("button"), { type: "button", textContent: c })
    b.addEventListener("click", () => mandar(`Procesa la solicitud ${c}`))
    $("casos").append(b)
  }
  const { status, cuerpo } = await api(`/api/sessions/${sessionId}`)
  if (status === 200) {
    cuerpo.historial.forEach(renderEvento)
    pedirConfirmacion(cuerpo.needsConfirmation)
  }
}
iniciar()
