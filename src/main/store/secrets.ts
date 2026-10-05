import { safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { secretsPath } from '../paths'

/**
 * 密钥库（PRD 第 17 章：密钥不出主进程）
 *
 * 存储布局：{userData}/secrets.enc
 * 文件内容是一个 JSON：{ "cloudApiKey": "<safeStorage 加密后 base64>" }
 *
 * 加密原理：
 * safeStorage 使用操作系统原生密钥设施——
 *   macOS: Keychain（加密密钥存在钥匙串里）
 *   Windows: DPAPI（用当前 Windows 用户凭据派生密钥）
 *   Linux: libsecret（GNOME Keyring / KWallet）
 * 应用代码拿到的只有密文；即使攻击者拷走 secrets.enc，换台电脑/换个用户也解不开。
 */

interface SecretMap {
  cloudApiKey?: string
}

/**
 * 内存缓存只保留明文（主进程独占，可接受）。
 * 关键约定：磁盘上的密文与内存中的明文绝不混存于同一个变量——
 * 否则"保存后本会话取密钥"会把明文误当 base64 密文送去解密而崩溃。
 */
let plaintextCache: SecretMap | null = null

function readPlaintext(): SecretMap {
  if (plaintextCache) return plaintextCache
  const file = secretsPath()
  if (!existsSync(file)) {
    plaintextCache = {}
    return plaintextCache
  }
  const raw = readFileSync(file, 'utf-8')
  const enc = raw.trim() ? (JSON.parse(raw) as SecretMap) : {}
  plaintextCache = {
    cloudApiKey: enc.cloudApiKey
      ? safeStorage.decryptString(Buffer.from(enc.cloudApiKey, 'base64'))
      : undefined
  }
  return plaintextCache
}

function writePlaintext(map: SecretMap): void {
  // Linux 无 keyring 守护进程时 isEncryptionAvailable() 为 false
  // （macOS Keychain / Windows DPAPI 通常恒可用）
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统密钥设施不可用（safeStorage unavailable），无法保存 API Key')
  }
  // 明文绝不落盘：写入前用系统密钥设施加密
  const onDisk: SecretMap = {}
  if (map.cloudApiKey) {
    onDisk.cloudApiKey = safeStorage.encryptString(map.cloudApiKey).toString('base64')
  }
  writeFileSync(secretsPath(), JSON.stringify(onDisk), { mode: 0o600 })
  plaintextCache = map
}

export function getCloudApiKey(): string | null {
  return readPlaintext().cloudApiKey ?? null
}

export function saveCloudApiKey(apiKey: string): void {
  const map = readPlaintext()
  const trimmed = apiKey.trim()
  // 空字符串语义为"清除密钥"
  map.cloudApiKey = trimmed ? trimmed : undefined
  writePlaintext(map)
}

export function hasCloudApiKey(): boolean {
  return Boolean(readPlaintext().cloudApiKey)
}
