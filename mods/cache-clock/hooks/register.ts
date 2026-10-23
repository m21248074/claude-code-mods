// Cache Clock: a prompt-cache line under the status line, drawn from the
// status line input's `prompt_cache`. Plugins cannot register a status line,
// so /cache-clock setup points statusLine at a script that runs the person's
// own status line first and adds the cache line under it.
import type { EngineInterface, Register } from 'claude-code'

// The scripts setup copies out of the plugin. They live in the config dir, not
// in the plugin's folder, which changes with every version of the mod.
const SCRIPTS = ['cache-clock.mjs', 'render.mjs']
// What marks a statusLine command as this mod's.
const MARK = 'cache-clock/cache-clock.mjs'
const REFRESH_SECONDS = 30
// The first Claude Code that sends `prompt_cache` to the status line.
const MIN_VERSION = [2, 1, 251]

type StatusLine = { type?: string; command?: string; refreshInterval?: number; [key: string]: unknown }
// What setup leaves for remove and for the script: the settings file it wrote,
// the statusLine that file had before, and the command the script runs first.
// One per settings file (setup-<key>.json), so setups in several projects and
// in the user settings each keep their own original.
type Saved = { file: string; previous: StatusLine | null; wrapped: string | null }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({
      name: 'cache-clock',
      description: '在狀態列下方加上一行提示快取資訊;/cache-clock remove 可移除',
      argumentHint: '[setup|remove]',
    }).catch(() => {}) // a name Claude Code already has is refused: start anyway
    void refreshScripts($).catch(() => {})
    return r
  })

  on('command.run', { command: 'cache-clock' }, async ($, e) => {
    const word = e.args.trim().toLowerCase()
    try {
      if (word === 'setup') return { text: await setup($) }
      if (word === 'remove') return { text: await remove($) }
      if (word === '') return { text: await status($) }
      return { text: '用法:/cache-clock [setup|remove]' }
    } catch (err) {
      return { text: `cache-clock: ${err instanceof Error ? err.message : String(err)}` }
    }
  })
}

async function setup($: EngineInterface) {
  const dir = await clockDir($)
  const found = await inForce($)
  if (found.source === 'policy' || found.source === 'flag') {
    const where = found.source === 'policy' ? '受管理的設定' : '--settings'
    return `你的狀態列來自${where},cache-clock 無法修改。沒有做任何變更。`
  }
  if (isOurs(found.statusLine)) {
    await copyScripts($, dir)
    return 'cache-clock 已經設定好了,腳本是最新的。'
  }

  const file = await targetFile($, found.source)
  const settings = await readJson($, file)
  const current = found.statusLine
  const wrapped = typeof current?.command === 'string' && current.command.trim() ? current.command : null
  const saved: Saved = { file, previous: asStatusLine(settings.statusLine), wrapped }
  const key = keyFor(file)

  await copyScripts($, dir)
  await $.fs.write(`${dir}/setup-${key}.json`, JSON.stringify(saved, null, 2) + '\n')

  const { command: _command, refreshInterval, ...kept } = current ?? {}
  settings.statusLine = {
    ...kept,
    type: 'command',
    command: `node "${shellQuoted(`${dir}/cache-clock.mjs`)}" ${key}`,
    refreshInterval: typeof refreshInterval === 'number' && refreshInterval < REFRESH_SECONDS ? refreshInterval : REFRESH_SECONDS,
  }
  await $.fs.write(file, JSON.stringify(settings, null, 2) + '\n')

  const lines = [
    wrapped
      ? `cache-clock 已設定在 ${file}。你原本的狀態列維持不變,快取那一行會顯示在它下面。`
      : `cache-clock 已設定在 ${file}。快取那一行就是你的狀態列。`,
    'Claude 下一次回覆後就會出現。輸入 /cache-clock remove 可還原。',
    ...(await warnings($)),
  ]
  return lines.join('\n')
}

// Takes out the setup in force here: the user settings', or this project's local one.
async function remove($: EngineInterface) {
  const dir = await clockDir($)
  const found = await inForce($)
  const file = await targetFile($, isOurs(found.statusLine) ? found.source : 'user')
  const key = keyFor(file)
  const saved = await readSaved($, `${dir}/setup-${key}.json`)
  if (!saved) return 'cache-clock 在這裡沒有設定,沒有做任何變更。'

  const settings = await readJson($, saved.file)
  if (!isOurs(asStatusLine(settings.statusLine))) {
    await $.fs.write(`${dir}/setup-${key}.json`, '{}\n')
    return `${saved.file} 裡的狀態列在設定後被改過,所以維持原樣。`
  }
  if (saved.previous) settings.statusLine = saved.previous
  else delete settings.statusLine
  await $.fs.write(saved.file, JSON.stringify(settings, null, 2) + '\n')
  await $.fs.write(`${dir}/setup-${key}.json`, '{}\n')
  return saved.previous
    ? `cache-clock 已移除。${saved.file} 裡你原本的狀態列已還原。`
    : `cache-clock 已從 ${saved.file} 移除。`
}

async function status($: EngineInterface) {
  const found = await inForce($)
  if (isOurs(found.statusLine)) {
    return ['cache-clock 已開啟。輸入 /cache-clock remove 可移除。', ...(await warnings($))].join('\n')
  }
  return 'cache-clock 未開啟。輸入 /cache-clock setup 可把快取那一行加到你的狀態列下方。'
}

// After an update of the mod, the copies setup made catch up with the new scripts.
async function refreshScripts($: EngineInterface) {
  if (!isOurs((await inForce($)).statusLine)) return
  const dir = await clockDir($)
  for (const name of SCRIPTS) {
    const fresh = await $.fs.read(`${$.plugin.root}/statusline/${name}`)
    const copy = await $.fs.read(`${dir}/${name}`).catch(() => null)
    if (copy !== fresh) await $.fs.write(`${dir}/${name}`, fresh)
  }
}

async function copyScripts($: EngineInterface, dir: string) {
  for (const name of SCRIPTS) {
    await $.fs.write(`${dir}/${name}`, await $.fs.read(`${$.plugin.root}/statusline/${name}`))
  }
}

async function warnings($: EngineInterface) {
  const out: string[] = []
  const node = await $.process.run(['node', '--version'], { timeoutMs: 5000 }).catch(() => null)
  if (!node || node.exitCode !== 0) out.push('警告:PATH 裡找不到 node,快取那一行需要 Node 才能執行。')
  const { base, version } = await $.session.version()
  if (isOlder(base ?? version, MIN_VERSION)) {
    out.push(`警告:Claude Code ${version} 比 2.1.251 舊,不會傳送快取資料,更新之前這一行會是空的。`)
  }
  return out
}

// The statusLine in force and the settings source it comes from, highest precedence first.
async function inForce($: EngineInterface) {
  for (const source of ['policy', 'flag', 'local', 'project', 'user'] as const) {
    const settings = await $.settings.read({ source }).catch(() => ({}))
    const statusLine = asStatusLine((settings as Record<string, unknown>).statusLine)
    if (statusLine) return { source, statusLine }
  }
  return { source: null, statusLine: null }
}

// The file setup writes: where the status line lives, except that a project's
// shared settings get a local override instead of a path from this machine.
async function targetFile($: EngineInterface, source: string | null) {
  const root = await $.session.root() // where Claude Code reads a project's settings from
  if (source === 'local' || source === 'project') return `${root}/.claude/settings.local.json`
  return `${await configDir($)}/settings.json`
}

async function configDir($: EngineInterface) {
  const custom = await $.env.get('CLAUDE_CONFIG_DIR')
  if (custom) return custom.replace(/\/+$/, '')
  const home = await $.env.get('HOME')
  if (!home) throw new Error('未設定 HOME,所以不知道 Claude 設定資料夾在哪裡。')
  return `${home}/.claude`
}

async function clockDir($: EngineInterface) {
  return `${await configDir($)}/cache-clock`
}

async function readJson($: EngineInterface, file: string): Promise<Record<string, unknown>> {
  if (!(await $.fs.exists(file))) return {}
  const text = await $.fs.read(file)
  if (!text.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${file} 不是有效的 JSON,所以維持原樣。`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file} 裡沒有設定物件。`)
  return parsed as Record<string, unknown>
}

async function readSaved($: EngineInterface, path: string): Promise<Saved | null> {
  const text = await $.fs.read(path).catch(() => null)
  if (!text) return null
  try {
    const saved = JSON.parse(text)
    return typeof saved?.file === 'string' ? (saved as Saved) : null
  } catch {
    return null
  }
}

// A short stable name for a settings file's saved state: FNV-1a of its path, in hex.
function keyFor(file: string) {
  let hash = 0x811c9dc5
  for (let i = 0; i < file.length; i++) hash = Math.imul(hash ^ file.charCodeAt(i), 0x01000193) >>> 0
  return hash.toString(16).padStart(8, '0')
}

// Safe inside double quotes for sh.
function shellQuoted(path: string) {
  return path.replace(/["\\$`]/g, c => `\\${c}`)
}

function asStatusLine(value: unknown): StatusLine | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as StatusLine) : null
}

function isOurs(statusLine: StatusLine | null) {
  return typeof statusLine?.command === 'string' && statusLine.command.includes(MARK)
}

function isOlder(version: string, min: number[]) {
  const parts = version.split(/[.-]/).slice(0, 3).map(Number)
  if (parts.some(Number.isNaN)) return false
  for (let i = 0; i < min.length; i++) {
    if (parts[i] !== min[i]) return parts[i] < min[i]
  }
  return false
}
