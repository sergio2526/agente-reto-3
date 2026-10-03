/**
 * Genera modulo/ desde las MISMAS fuentes que usa la aplicación (sin copias divergentes):
 *   agent/prompt.md                 → modulo/agent.md (frontmatter + prompt)
 *   src/knowledge/ordenes-compra.md → modulo/skill/ordenes-compra/SKILL.md (frontmatter + conocimiento)
 *   src/tools/oc.ts                 → modulo/tools/oc.ts (re-exporta las herramientas, no las copia)
 *
 *   bun run modulo          regenera
 *   bun run modulo:check    falla si modulo/ no está sincronizado
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

const prompt = await readFile("agent/prompt.md", "utf8")
const conocimiento = await readFile("src/knowledge/ordenes-compra.md", "utf8")

const AVISO = "<!-- Generado por `bun run modulo` desde agent/prompt.md. No editar a mano. -->"
const AVISO_SKILL = "<!-- Generado por `bun run modulo` desde src/knowledge/ordenes-compra.md. No editar a mano. -->"

const esperados: Record<string, string> = {
  "modulo/agent.md": `---
description: Prepara, valida y crea órdenes de compra en SAP a partir del paquete de solicitud (correo, Excel, cotización, aprobación), devolviendo al humano las excepciones con una recomendación.
mode: primary
permission:
  edit: deny
  bash: deny
---
${AVISO}

${prompt}`,
  "modulo/skill/ordenes-compra/SKILL.md": `---
name: ordenes-compra
description: Conocimiento del proceso de órdenes de compra en SAP de Periferia — reglas de control RC1–RC10, confirmación humana, estructura del payload, unidades, IVA, condiciones de pago, evidencia e idempotencia. Úsalo al procesar o explicar una solicitud de compra.
---
${AVISO_SKILL}

${conocimiento}`,
  "modulo/tools/oc.ts": `// Herramientas del agente de órdenes de compra, importables sin el servidor HTTP.
// Re-exporta la implementación de la aplicación: es la misma pieza, no una copia.
// Contrato: cada export es { description, args (zod), execute(args, { directory, sessionId }) → Promise<string> }.
export { leer_paquete, validar, construir_payload, generar_evidencia, crear } from "../../src/tools/oc.ts"
export { consultar } from "../../src/tools/conocimiento.ts"
export type { ContextoHerramienta, Herramienta, OrdenCompra, Paquete, Validacion } from "../../src/tools/tipos.ts"
`,
}

const verificar = process.argv.includes("--check")
let desfasados = 0
for (const [ruta, contenido] of Object.entries(esperados)) {
  const actual = await readFile(ruta, "utf8").catch(() => null)
  if (actual === contenido) continue
  if (verificar) {
    console.error(`✗ ${ruta} no está sincronizado con su fuente`)
    desfasados++
    continue
  }
  await mkdir(dirname(ruta), { recursive: true })
  await writeFile(ruta, contenido)
  console.log(`✔ ${ruta}`)
}
if (verificar) {
  if (desfasados) process.exit(1)
  console.log("✔ modulo/ sincronizado con agent/prompt.md, src/knowledge/ y src/tools/")
}
