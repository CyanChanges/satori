import * as QQ from './types'
import { Dict, h, MessageEncoder } from '@satorijs/satori'
import { QQBot } from './bot'
import FormData from 'form-data'
import { decodeMessage } from './utils'
import { escape } from '@satorijs/element'
import { QQGuildBot } from './bot/guild'

export class QQGuildMessageEncoder extends MessageEncoder<QQGuildBot> {
  private content: string = ''
  private file: Buffer
  private filename: string
  fileUrl: string
  reference: string
  dms: QQ.DMS

  async initDms() {
    const dms = await this.bot.internal.createDMS(this.options.session.userId, this.session.guildId || this.options.session.guildId)
    this.bot.ctx.logger('qq').debug(require('util').inspect(dms, false, null, true))
    this.dms = dms
  }

  async prepare() {
    if (this.session.isDirect && !this.options.session) {
      // initiative send
      await this.initDms()
    }
  }

  // 先文后图
  async flush() {
    if (!this.content.trim().length && !this.file && !this.fileUrl) {
      return
    }
    let endpoint = `/channels/${this.session.channelId}/messages`
    // let srcGuildId // directMsg
    if (this.session.isDirect && !this.options?.session) {
      // initiative send
      endpoint = `/dms/${this.dms.guild_id}/messages`
      // srcGuildId = this.session.guildId
    } else if (this.session.isDirect && this.options?.session) {
      // @ts-ignore
      const payload = this.options.session.qq.d as QQ.Message
      endpoint = `/dms/${payload.guild_id}/messages`
      // srcGuildId = payload.src_guild_id
    }

    const useFormData = Boolean(this.file)
    let r: QQ.Message
    this.bot.ctx.logger('qq').debug('use form data %s', useFormData)
    if (useFormData) {
      const form = new FormData()
      form.append('content', this.content)
      if (this.options?.session) {
        form.append('msg_id', this.options?.session?.messageId)
      }
      if (this.file) {
        form.append('file_image', this.file, this.filename)
      }
      // if (this.fileUrl) {
      //   form.append('image', this.fileUrl)
      // }
      r = await this.bot.http.post<QQ.Message>(endpoint, form, {
        headers: form.getHeaders(),
      })
    } else {
      r = await this.bot.http.post<QQ.Message>(endpoint, {
        ...{
          content: this.content,
          msg_id: this.options.session.messageId ?? this.options.session.id,
          image: this.fileUrl,
        },
        ...(this.reference ? {
          messageReference: {
            message_id: this.reference,
          },
        } : {}),
      })
    }

    this.bot.ctx.logger('qq').debug(require('util').inspect(r, false, null, true))
    const session = this.bot.session()
    session.type = 'send'
    await decodeMessage(this.bot, r, session.body.message = {}, session.body)
    if (this.session.isDirect) {
      session.guildId = this.session.guildId
      session.channelId = this.session.channelId
      session.isDirect = true
    }

    // https://bot.q.qq.com/wiki/develop/api/gateway/direct_message.html#%E6%B3%A8%E6%84%8F
    this.results.push(session)
    session.app.emit(session, 'send', session)
    this.content = ''
    this.file = null
    this.filename = null
    this.fileUrl = null
  }

  async resolveFile(attrs: Dict) {
    if (attrs.url.startsWith('http')) {
      return this.fileUrl = attrs.url
    }
    const { data, filename } = await this.bot.ctx.http.file(attrs.url, attrs)
    this.file = Buffer.from(data)
    this.filename = filename
  }

  async visit(element: h) {
    const { type, attrs, children } = element
    if (type === 'text') {
      this.content += escape(attrs.content)
    } else if (type === 'at') {
      switch (attrs.type) {
        case 'all':
          this.content += `@everyone`
          break
        default:
          this.content += `<@${attrs.id}>`
      }
    } else if (type === 'br') {
      this.content += '\n'
    } else if (type === 'p') {
      if (!this.content.endsWith('\n')) this.content += '\n'
      await this.render(children)
      if (!this.content.endsWith('\n')) this.content += '\n'
    } else if (type === 'sharp') {
      this.content += `<#${attrs.id}>`
    } else if (type === 'quote') {
      this.reference = attrs.id
      await this.flush()
    } else if (type === 'image' && attrs.url) {
      await this.flush()
      await this.resolveFile(attrs)
      await this.flush()
    } else if (type === 'message') {
      await this.flush()
      await this.render(children)
      await this.flush()
    } else {
      await this.render(children)
    }
  }
}

export class QQMessageEncoder extends MessageEncoder<QQBot> {
  private content: string = ''
  async flush() {
    if (!this.content.trim()) return
    const data: QQ.SendMessageParams = {
      content: this.content,
      msg_type: 0,
      timestamp: Math.floor(Date.now() / 1000),
      msg_id: this.options.session.messageId,
    }
    const session = this.bot.session()
    session.type = 'send'
    if (this.session.isDirect) {
      const { sendResult: { msg_id } } = await this.bot.internal.sendPrivateMessage(this.options.session.body.message.user.id, data)
      session.messageId = msg_id
    } else {
      await this.bot.internal.sendMessage(this.session.guildId, data)
    }

    this.results.push(session)
    session.app.emit(session, 'send', session)
  }

  async sendFile(type: string, attrs: Dict) {
    if (!attrs.url.startsWith('http')) {
      return this.bot.ctx.logger('qq').warn('unsupported file url %s', attrs.url)
    }
    let file_type = 0
    if (type === 'image') file_type = 1
    else if (type === 'video') file_type = 2
    else return
    const data: QQ.SendFileParams = {
      file_type,
      url: attrs.url,
      srv_send_msg: true,
    }
    if (this.session.isDirect) {
      await this.bot.internal.sendFilePrivate(this.options.session.body.message.user.id, data)
    } else {
      await this.bot.internal.sendFileGuild(this.session.guildId, data)
    }
  }

  async visit(element: h) {
    const { type, attrs, children } = element
    if (type === 'text') {
      this.content += escape(attrs.content)
    } else if (type === 'image' && attrs.url) {
      await this.sendFile(type, attrs)
    } else if (type === 'video' && attrs.url) {
      await this.sendFile(type, attrs)
    } else if (type === 'message') {
      await this.flush()
      await this.render(children)
      await this.flush()
    } else {
      await this.render(children)
    }
  }
}
