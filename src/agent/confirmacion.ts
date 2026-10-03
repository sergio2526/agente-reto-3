/** Detección de la confirmación humana explícita (CA3). Conservadora: ante la duda, no es confirmación. */

const AFIRMATIVO = /^\s*(s[ií]|confirmo|confirmado|confirmada|ok|okay|dale|adelante|procede|proceder|de acuerdo|aprobado|cr[eé]ala|cr[eé]alas|autorizo)(?=$|[\s,.;:!¡])/i
const NEGATIVO = /(^|[\s,.;:¡!¿])(no|cancela|cancelar|espera|detente|alto)(?=$|[\s,.;:!?])/i

export const esConfirmacion = (texto: string): boolean => AFIRMATIVO.test(texto) && !NEGATIVO.test(texto)
