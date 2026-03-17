import('./config.js')

import baileys from '@whiskeysockets/baileys'

const {
  default: makeWASocket,
  Browsers,
  delay,
  fetchLatestBaileysVersion,
  generateWAMessageFromContent,
  proto
} = baileys

import { Boom } from '@hapi/boom'
import fs from 'fs'
import pino from 'pino'
import serialize, { Client } from '#lib/serialize.js'
import log from '#lib/logger.js'
import PluginsLoad from '#lib/loadPlugins.js'
import sqlAuth from '#lib/sqlauth.js'

const loader = new PluginsLoad('./plugins', { debug: true })
await loader.load()
global.plugins = loader.plugins

const MAX_MSG_PER_CHAT = 20
const MAX_CHATS = 300
const GC_INTERVAL = 10 * 60 * 1000

let handler = null

async function loadHandler() {
  try {
    handler = (await import(`./handler.js?v=${Date.now()}`)).default
  } catch (err) {
    log.error('Gagal load handler:', err.message)
  }
}

await loadHandler()
setInterval(loadHandler, 30000)

function runGC(conn) {
  if (!conn.messages) return
  for (const [chat, msgs] of conn.messages.entries()) {
    if (msgs.length > MAX_MSG_PER_CHAT) conn.messages.set(chat, msgs.slice(-MAX_MSG_PER_CHAT))
  }
  if (conn.messages.size > MAX_CHATS) {
    const keys = [...conn.messages.keys()]
    for (const key of keys.slice(0, conn.messages.size - MAX_CHATS)) conn.messages.delete(key)
  }
  if (global.gc) global.gc()
}

async function startWA() {
  const { state, saveCreds } = await sqlAuth('./sessions')
  const { version } = await fetchLatestBaileysVersion()

  const conn = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu('Edge'),
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: true,
    getMessage: async key => {
      if (!conn.messages) return { conversation: '' }
      const msgs = conn.messages.get(key.remoteJid) || []
      return msgs.find(x => x.id === key.id)?.message || { conversation: '' }
    }
  })

  await Client(conn)
  conn.chats ??= {}
  conn.messages = new Map()

  setInterval(() => runGC(conn), GC_INTERVAL)

  if (!state.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await conn.requestPairingCode(PAIRING_NUMBER, 'SIBAYUXD')
        log.info(`Pairing Code: ${code}`)
      } catch (err) {
        log.error(`Gagal ambil pairing code: ${err}`)
      }
    }, 3000)
  }

  conn.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection) log.info(`Connection Status: ${connection}`)

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode

      switch (statusCode) {
        case 408:
        case 503:
        case 428:
        case 515:
          await startWA()
          break

        case 401:
        case 403:
        case 405:
          fs.rmSync('./sessions', { recursive: true, force: true })
          await startWA()
          break

        default:
          await startWA()
      }
    }

    if (connection === 'open') {
      log.success('Bot connected successfully.')
      conn.chats = await conn.groupFetchAllParticipating()
    }
  })

  conn.ev.on('creds.update', saveCreds)

  conn.ev.on('groups.update', updates => {
    for (const update of updates) {
      const id = update.id
      if (conn.chats[id]) conn.chats[id] = { ...conn.chats[id], ...update }
    }
  })

  conn.ev.on('group-participants.update', ({ id, participants, action }) => {
    const metadata = conn.chats[id]
    if (!metadata) return

    switch (action) {
      case 'add':
      case 'revoked_membership_requests':
        participants.forEach(p => metadata.participants.push(p))
        break

      case 'demote':
      case 'promote':
        for (const p of participants) {
          const target = metadata.participants.find(x => x.id === p.id)
          if (target) target.admin = action === 'promote' ? 'admin' : null
        }
        break

      case 'remove':
        metadata.participants = metadata.participants.filter(p => !participants.includes(p.id))
        break
    }
  })

  conn.ev.on('messages.upsert', async ({ messages }) => {
    if (!messages[0]) return

    const m = await serialize(conn, messages[0]).catch(() => null)
    if (!m) return

    conn.messages ??= new Map()
    if (!conn.messages.has(m.chat)) conn.messages.set(m.chat, [])
    const chatMsgs = conn.messages.get(m.chat)
    chatMsgs.push(m)
    if (chatMsgs.length > MAX_MSG_PER_CHAT) chatMsgs.shift()

    const body = (m.body || m.text || '').trim().toLowerCase()

    if (body === 'bot') {
      try {
        const msg = generateWAMessageFromContent(
          m.chat,
          proto.Message.fromObject({
            requestPhoneNumberMessage: { text: 'Bagikan nomor telepon Anda' }
          }),
          { userJid: conn.user.id }
        )
        await conn.relayMessage(m.chat, msg.message, { messageId: msg.key.id })
      } catch (err) {
        log.error('Gagal kirim request phone:', err.message)
      }
      return
    }

    if (m.chat.endsWith('@broadcast') || m.chat.endsWith('@newsletter')) {
      for (const plugin of Object.values(plugins)) {
        if (typeof plugin.on === 'function') {
          try {
            await plugin.on(conn, m, {})
          } catch {}
        }
      }
      return
    }

    if (!m.message || m.isBot) return
    if (m.type === 'protocolMessage') return

    try {
      await import(`#lib/print.js?v=${Date.now()}`).then(mod => mod.default(conn, m)).catch(() => {})
    } catch {}

    try {
      if (handler) await handler(conn, m)
    } catch (err) {
      log.error('Handler error:', err.message)
    }
  })
}

startWA()
