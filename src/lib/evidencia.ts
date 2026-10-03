import { createHash } from "node:crypto"
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"
import type { AprobacionFixture } from "../tools/tipos.ts"

/** Contenido canónico de la evidencia: encabezados + cuerpo. El sha256 se calcula sobre este texto. */
export const contenidoEvidencia = (a: AprobacionFixture): string =>
  [
    "EVIDENCIA DE APROBACIÓN",
    `De: ${a.de}`,
    `Para: ${a.para}`,
    ...(a.cc?.length ? [`CC: ${a.cc.join(", ")}`] : []),
    `Fecha: ${a.fecha}`,
    `Asunto: ${a.asunto}`,
    "",
    a.cuerpo,
    "",
  ].join("\n")

export const sha256 = (texto: string): string => createHash("sha256").update(texto, "utf8").digest("hex")

export const textoEvidencia = (a: AprobacionFixture): { texto: string; hash: string } => {
  const contenido = contenidoEvidencia(a)
  const hash = sha256(contenido)
  return { texto: `${contenido}\n---\nsha256 (contenido anterior a esta línea): ${hash}\n`, hash }
}

/** PDF determinista (fechas de metadatos fijadas a la aprobación) con el mismo contenido del TXT. */
export const pdfEvidencia = async (a: AprobacionFixture, texto: string): Promise<Uint8Array> => {
  const pdf = await PDFDocument.create()
  const fecha = new Date(a.fecha)
  pdf.setCreationDate(fecha)
  pdf.setModificationDate(fecha)
  pdf.setTitle(`Evidencia de aprobación - ${a.asunto}`)
  pdf.setProducer("agente-oc-sap")
  pdf.setCreator("agente-oc-sap")
  const fuente = await pdf.embedFont(StandardFonts.Helvetica)
  const negrita = await pdf.embedFont(StandardFonts.HelveticaBold)
  let pagina = pdf.addPage([595, 842])
  let y = 800
  for (const [i, linea] of envolver(texto, 95).entries()) {
    if (y < 50) {
      pagina = pdf.addPage([595, 842])
      y = 800
    }
    pagina.drawText(linea, { x: 50, y, size: i === 0 ? 14 : 10, font: i === 0 ? negrita : fuente, color: rgb(0.1, 0.1, 0.1) })
    y -= i === 0 ? 24 : 14
  }
  return pdf.save({ useObjectStreams: false })
}

const envolver = (texto: string, ancho: number): string[] =>
  texto.split("\n").flatMap((linea) => {
    if (linea.length <= ancho) return [linea]
    const partes: string[] = []
    let actual = ""
    for (const palabra of linea.split(" ")) {
      if ((actual + " " + palabra).trim().length > ancho) {
        partes.push(actual)
        actual = palabra
      } else actual = (actual + " " + palabra).trim()
    }
    return [...partes, actual]
  })
