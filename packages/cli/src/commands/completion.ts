import type { Command } from 'commander'
import { DOCS_TOPICS } from '../constants'
import { usageError } from '../errors'
import type { Act } from './shared'

/**
 * Shell completions, generated from the live command tree so they can't drift.
 *
 *   invoice-ai completion zsh  > "${fpath[1]}/_invoice-ai"
 *   invoice-ai completion bash > ~/.local/share/bash-completion/completions/invoice-ai
 *   invoice-ai completion fish > ~/.config/fish/completions/invoice-ai.fish
 */

const SHELLS = ['bash', 'zsh', 'fish'] as const

/** Extra words for positional arguments with a fixed set of values. */
const ARGUMENT_CHOICES: Record<string, string[]> = {
  completion: [...SHELLS],
  docs: Object.keys(DOCS_TOPICS),
  open: ['dashboard', 'invoices', 'customers', 'products', 'settings', 'api-keys', 'webhooks', 'invoice'],
}

interface Node {
  path: string
  words: string[]
}

export function commandTree(program: Command): Node[] {
  const globals = program.options.map((o) => o.long).filter((l): l is string => Boolean(l))
  const nodes: Node[] = []
  const walk = (cmd: Command, path: string) => {
    const subs = cmd.commands.filter((c) => !(c as unknown as { _hidden?: boolean })._hidden)
    const words = [
      ...subs.flatMap((c) => [c.name(), ...c.aliases()]),
      ...(ARGUMENT_CHOICES[path] ?? []),
      ...cmd.options.map((o) => o.long).filter((l): l is string => Boolean(l)),
      ...(path ? globals : []),
      '--help',
    ]
    nodes.push({ path, words: [...new Set(words)] })
    for (const sub of subs) {
      for (const name of [sub.name(), ...sub.aliases()]) walk(sub, path ? `${path} ${name}` : name)
    }
  }
  walk(program, '')
  return nodes
}

export function completionScript(shell: string, program: Command): string {
  const nodes = commandTree(program)
  const bin = program.name()
  const fn = `_${bin.replace(/[^a-zA-Z0-9]/g, '_')}`
  switch (shell) {
    case 'bash':
      return bashScript(nodes, bin, fn)
    case 'zsh':
      return `#compdef ${bin}\n# zsh completion for ${bin} (uses bash completion under the hood)\nautoload -U +X bashcompinit && bashcompinit\n${bashScript(nodes, bin, fn)}`
    case 'fish':
      return fishScript(nodes, bin, fn)
    default:
      throw usageError(`Unsupported shell "${shell}".`, `Use one of: ${SHELLS.join(', ')}.`)
  }
}

function bashScript(nodes: Node[], bin: string, fn: string): string {
  const cases = nodes.map((n) => `    "${n.path}") echo "${n.words.join(' ')}" ;;`).join('\n')
  return `# bash completion for ${bin}
${fn}_words() {
  case "$1" in
${cases}
    *) return 1 ;;
  esac
}
${fn}() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" path="" i w
  for ((i = 1; i < COMP_CWORD; i++)); do
    w="\${COMP_WORDS[i]}"
    [[ "$w" == -* ]] && continue
    if ${fn}_words "\${path:+$path }$w" > /dev/null; then path="\${path:+$path }$w"; fi
  done
  COMPREPLY=( $(compgen -W "$(${fn}_words "$path")" -- "$cur") )
}
complete -o default -F ${fn} ${bin}
`
}

function fishScript(nodes: Node[], bin: string, fn: string): string {
  const q = (s: string) => `'${s.replace(/'/g, "\\'")}'`
  const lines = [
    `# fish completion for ${bin}`,
    `set -g ${fn}_cmds ${nodes.filter((n) => n.path).map((n) => q(n.path)).join(' ')}`,
    `function ${fn}_path`,
    '    set -l tokens (commandline -opc)',
    '    set -e tokens[1]',
    '    set -l path',
    '    for t in $tokens',
    "        string match -q -- '-*' $t; and continue",
    `        if contains -- (string join ' ' $path $t) $${fn}_cmds`,
    '            set path $path $t',
    '        end',
    '    end',
    "    string join ' ' $path",
    'end',
    `function ${fn}_is`,
    `    set -l p (${fn}_path)`,
    '    test "$p" = "$argv"',
    'end',
    `complete -c ${bin} -f`,
    ...nodes.map((n) => `complete -c ${bin} -n ${q(`${fn}_is ${n.path}`)} -a ${q(n.words.join(' '))}`),
  ]
  return `${lines.join('\n')}\n`
}

export function registerCompletion(program: Command, act: Act): void {
  program
    .command('completion <shell>')
    .description('Print a shell completion script (bash, zsh or fish)')
    .addHelpText(
      'after',
      '\nInstall:\n  bash  $ invoice-ai completion bash > ~/.local/share/bash-completion/completions/invoice-ai\n  zsh   $ invoice-ai completion zsh > "${fpath[1]}/_invoice-ai"\n  fish  $ invoice-ai completion fish > ~/.config/fish/completions/invoice-ai.fish',
    )
    .action(
      act(async (ctx, [shell]) => {
        ctx.deps.stdout.write(completionScript(shell!, program))
      }),
    )
}
