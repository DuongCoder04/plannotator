// The Inbox reminder (#2243): what a conversation's first prompt carries
// (pure rules), and the plugin's SessionStart `compact` command hook, run for
// real under sh and bash (and PowerShell when it is installed) from the
// command hooks.json ships.
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { conversationResumed, INBOX_REMINDER_ENV, inboxFirstPromptContext, inboxReminderEnvValue } from './inbox'
import { inboxReminderText } from './inbox-contract'

const TOOL = 'mcp__plugin_plannotator_tools__plannotator_inbox'
/**
 * A custom reminder (#2194) holding everything a shell or echo would read:
 * backslash escapes, a leading -n, printf's %, quotes, command substitutions
 * that would leave a marker file, a variable, and line breaks.
 */
const MARKER = `/tmp/plannotator-reminder-pwned-${process.pid}`
const HOSTILE = `-n Ask first. a\\b \\c\\n 100% %s %d "double" 'single' $(touch ${MARKER}-1) \`touch ${MARKER}-2\` \${HOME} $HOME\nsecond line\n\tthird \\ end\n`

describe("the first prompt's context", () => {
  // Every row: delivered × resumed × meta × command.
  const rows: Array<[delivered: boolean, resumed: boolean, isMeta: boolean, command: boolean, carries: 'reminder' | 'threads' | null]> = [
    // A conversation that started in this process: the reminder.
    [false, false, false, false, 'reminder'],
    // A resumed one holds the reminder already: its open threads instead, never a second reminder.
    [false, true, false, false, 'threads'],
    // Its first prompt went in already: nothing more, resumed or not.
    [true, false, false, false, null],
    [true, true, false, false, null],
    // A meta prompt or a slash command never carries either.
    [false, false, true, false, null],
    [false, true, true, false, null],
    [false, false, false, true, null],
    [false, true, false, true, null],
  ]
  for (const [delivered, resumed, isMeta, command, carries] of rows) {
    test(`delivered=${delivered} resumed=${resumed} isMeta=${isMeta} command=${command} → ${carries}`, () => {
      expect(inboxFirstPromptContext({ delivered, resumed, isMeta, command })).toBe(carries)
    })
  }
})

describe('telling a resumed conversation from one that starts here', () => {
  test('an assistant row already there: resumed (--resume, --continue, /resume, a fork)', () => {
    expect(conversationResumed([{ role: 'user', text: 'Ship it.' }, { role: 'assistant', text: 'Shipped.' }])).toBe(true)
  })
  test('nothing yet, or only rows of the person (a command they ran first): starts here', () => {
    expect(conversationResumed([])).toBe(false)
    expect(conversationResumed([{ role: 'user', text: '/plannotator-review' }])).toBe(false)
  })
  test('nothing readable: starts here, so the reminder goes', () => {
    for (const value of [undefined, null, 'x', {}, [null, 'assistant', { role: 'system' }]]) expect(conversationResumed(value)).toBe(false)
  })
})

describe('PLANNOTATOR_INBOX_REMINDER', () => {
  test('the reminder naming the tool by its registered name while on; unset otherwise', () => {
    expect(inboxReminderEnvValue(true, TOOL)).toBe(inboxReminderText(TOOL))
    expect(inboxReminderEnvValue(true, TOOL)).toContain(`${TOOL} send_message`)
    expect(inboxReminderEnvValue(false, TOOL)).toBeUndefined()
    expect(inboxReminderEnvValue(true, null)).toBeUndefined()
  })

  // #2194: a custom text is published as it is, whatever it holds; the hook prints it with printf.
  test('a custom text is published byte for byte, backslashes and a leading dash included', () => {
    expect(inboxReminderEnvValue(true, TOOL, HOSTILE)).toBe(HOSTILE)
    expect(inboxReminderEnvValue(true, 'a\\b')).toBe(inboxReminderText('a\\b'))
  })

  test('register.ts sets it under exactly this name (a string literal, as claude plugin validate needs)', () => {
    const source = readFileSync(join(import.meta.dir, 'register.ts'), 'utf8')
    expect(INBOX_REMINDER_ENV).toBe('PLANNOTATOR_INBOX_REMINDER')
    expect(source).toContain(`$.env.set('${INBOX_REMINDER_ENV}', inboxReminderEnvValue(`)
  })
})

describe("hooks.json's SessionStart compact hook", () => {
  const hooks = JSON.parse(readFileSync(join(import.meta.dir, '..', 'hooks.json'), 'utf8')) as {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>>
  }
  const entries = hooks.hooks.SessionStart ?? []
  const command = entries[0]?.hooks[0]?.command ?? ''

  test('one command hook, matched on compact alone, short timeout, never the plannotator binary', () => {
    expect(entries).toHaveLength(1)
    expect(entries[0]?.matcher).toBe('compact')
    expect(entries[0]?.hooks).toHaveLength(1)
    expect(entries[0]?.hooks[0]?.type).toBe('command')
    expect(entries[0]?.hooks[0]?.timeout).toBe(5)
    expect(command).toContain(`$${INBOX_REMINDER_ENV}`)
    expect(command).not.toMatch(/\bplannotator\b(?!_)/i)
  })

  /** The command as a hook process runs it: a clean environment, plus the variable when given. */
  function run(shell: string, args: string[], value?: string) {
    const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin' }
    if (value !== undefined) env[INBOX_REMINDER_ENV] = value
    return spawnSync(shell, [...args, command], { env, encoding: 'utf8', timeout: 10_000 })
  }

  const text = inboxReminderText(TOOL)
  // dash is Debian's and Ubuntu's /bin/sh (CI); its echo read backslashes, which is why the hook uses printf.
  const shells = ['/bin/sh', '/bin/bash', ...['/usr/bin/dash', '/bin/dash'].filter((path) => existsSync(path)).slice(0, 1)]
  for (const shell of shells) {
    test(`${shell}: set, prints the text and one newline; exit 0`, () => {
      const result = run(shell, ['-c'], text)
      expect(result.status).toBe(0)
      expect(result.stdout).toBe(`${text}\n`)
      expect(result.stderr).toBe('')
    })
    test(`${shell}: a custom text with backslashes, -n, %, quotes, $(...), backticks and line breaks comes out byte for byte, and nothing in it runs`, () => {
      const result = run(shell, ['-c'], HOSTILE)
      expect(result.status).toBe(0)
      expect(result.stdout).toBe(`${HOSTILE}\n`)
      expect(result.stderr).toBe('')
      expect(existsSync(`${MARKER}-1`)).toBe(false)
      expect(existsSync(`${MARKER}-2`)).toBe(false)
    })
    test(`${shell}: unset, prints only whitespace (the engine trims it to nothing); exit 0`, () => {
      const result = run(shell, ['-c'])
      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe('')
      expect(result.stderr).toBe('')
    })
  }

  // Claude Code runs a Windows hook in Git Bash, else PowerShell (-NoProfile);
  // there `$PLANNOTATOR_INBOX_REMINDER` is a PowerShell variable, always empty
  // (the mod never runs on Windows anyway). The line must parse and exit 0.
  const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { encoding: 'utf8' })
  test.skipIf(pwsh.status !== 0)('PowerShell: prints only whitespace and exits 0, set or not', () => {
    for (const value of [undefined, text, HOSTILE]) {
      const result = run('pwsh', ['-NoProfile', '-NonInteractive', '-Command'], value)
      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe('')
      expect(result.stderr).toBe('')
    }
  })
})
