import { defaultDeps } from './deps'
import { run } from './run'

// Set the exit code rather than calling process.exit(): on macOS, stdout to a
// pipe is asynchronous, and exiting early would truncate large JSON output.
run(process.argv.slice(2), defaultDeps()).then(
  (code) => {
    process.exitCode = code
  },
  (err: unknown) => {
    process.stderr.write(`Unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
    process.exitCode = 1
  },
)
