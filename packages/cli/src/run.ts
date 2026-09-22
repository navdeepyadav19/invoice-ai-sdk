import { CommanderError } from 'commander'
import { configDir } from './auth/config'
import type { Deps } from './deps'
import { ExitCode, exitCodeFor, formatError, usageError } from './errors'
import { buildProgram } from './program'
import { colorsEnabled, makeColors } from './util/colors'
import { checkForUpdate } from './util/update-notifier'

/** Runs one CLI invocation and returns its exit code. Never throws. */
export async function run(argv: string[], deps: Deps): Promise<number> {
  const program = buildProgram(deps)
  const noColorFlag = argv.includes('--no-color')
  const c = makeColors(colorsEnabled(deps.env, Boolean(deps.stderr.isTTY), !noColorFlag))
  const wantsJson = argv.includes('--json')

  let notice: string | undefined
  try {
    notice = checkForUpdate({
      env: deps.env,
      stderrIsTTY: Boolean(deps.stderr.isTTY) && !wantsJson,
      configDir: configDir(deps.env),
      now: deps.now(),
    })
  } catch {
    notice = undefined
  }

  let code: number = ExitCode.OK
  try {
    if (argv.length === 0) {
      program.outputHelp()
    } else {
      await program.parseAsync(argv, { from: 'user' })
    }
  } catch (err) {
    code = handleError(err, deps, c)
  }

  if (notice && code === ExitCode.OK) deps.stderr.write(`\n${c.yellow(notice)}\n`)
  return code
}

function handleError(err: unknown, deps: Deps, c: ReturnType<typeof makeColors>): number {
  if (err instanceof CommanderError) {
    // --help and --version end here too, successfully.
    if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version' || err.code === 'commander.help') {
      return ExitCode.OK
    }
    const message = err.message.replace(/^error:\s*/i, '')
    const usage = usageError(message.charAt(0).toUpperCase() + message.slice(1), 'Run with --help to see usage.')
    deps.stderr.write(`${formatError(usage, c)}\n`)
    return ExitCode.USAGE
  }
  deps.stderr.write(`${formatError(err, c)}\n`)
  return exitCodeFor(err)
}
