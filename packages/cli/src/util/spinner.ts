import type { OutStream } from '../deps'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export interface Spinner {
  start(message: string): void
  update(message: string): void
  stop(finalLine?: string): void
}

/**
 * A spinner on stderr, so stdout stays clean for pipes. When disabled (no
 * TTY, CI) it prints the first message once and the final line, nothing else.
 */
export function makeSpinner(stream: OutStream, enabled: boolean): Spinner {
  let timer: ReturnType<typeof setInterval> | undefined
  let message = ''
  let frame = 0
  const draw = () => {
    stream.write(`\r\x1b[2K${FRAMES[frame++ % FRAMES.length]} ${message}`)
  }
  return {
    start(msg) {
      message = msg
      if (!enabled) {
        stream.write(`${msg}\n`)
        return
      }
      draw()
      timer = setInterval(draw, 80)
      timer.unref?.()
    },
    update(msg) {
      message = msg
    },
    stop(finalLine) {
      if (timer) clearInterval(timer)
      timer = undefined
      if (enabled) stream.write('\r\x1b[2K')
      if (finalLine) stream.write(`${finalLine}\n`)
    },
  }
}
