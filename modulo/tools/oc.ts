// Herramientas del agente de órdenes de compra, importables sin el servidor HTTP.
// Re-exporta la implementación de la aplicación: es la misma pieza, no una copia.
// Contrato: cada export es { description, args (zod), execute(args, { directory, sessionId }) → Promise<string> }.
export { leer_paquete, validar, construir_payload, generar_evidencia, crear } from "../../src/tools/oc.ts"
export { consultar } from "../../src/tools/conocimiento.ts"
export type { ContextoHerramienta, Herramienta, OrdenCompra, Paquete, Validacion } from "../../src/tools/tipos.ts"
