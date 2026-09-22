import pc from 'picocolors'

export type Colors = ReturnType<typeof pc.createColors>

/**
 * Colour only when writing to a terminal, and never when NO_COLOR is set,
 * --no-color is passed, or TERM=dumb. FORCE_COLOR wins over everything.
 */
export function colorsEnabled(env: Record<string, string | undefined>, isTTY: boolean, flag: boolean): boolean {
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true
  if (!flag) return false
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false
  if (env.TERM === 'dumb') return false
  return isTTY
}

export function makeColors(enabled: boolean): Colors {
  return pc.createColors(enabled)
}
