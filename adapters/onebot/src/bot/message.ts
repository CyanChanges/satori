import { Dict, Messenger, segment } from '@satorijs/satori'
import { BaseBot } from './base'
import { CQCode } from './cqcode'

class State {
  author: Dict = {}
  children: CQCode[] = []

  constructor(public type: 'message' | 'forward' | 'reply') {}
}

export class OneBotMessenger extends Messenger<BaseBot> {
  stack: State[] = [new State('message')]
  children: CQCode[] = []

  async forward() {
    if (!this.stack[0].children.length) return
    const session = this.bot.session(this.session)
    session.messageId = this.guildId
      ? '' + await this.bot.internal.sendGroupForwardMsg(this.guildId, this.stack[0].children)
      : '' + await this.bot.internal.sendPrivateForwardMsg(this.channelId.slice(8), this.stack[0].children)
    session.app.emit(session, 'send', session)
    this.results.push(session)
  }

  async flush() {
    // trim start
    while (true) {
      const first = this.children[0]
      if (first?.type !== 'text') break
      first.data.text = first.data.text.trimStart()
      if (first.data.text) break
      this.children.shift()
    }

    // trim end
    while (true) {
      const last = this.children[this.children.length - 1]
      if (last?.type !== 'text') break
      last.data.text = last.data.text.trimEnd()
      if (last.data.text) break
      this.children.pop()
    }

    // flush
    if (!this.children.length) return
    if (this.stack[0].type === 'forward') {
      this.stack[1].children.push({
        type: 'node',
        data: {
          name: this.stack[0].author.name || this.bot.nickname || this.bot.username,
          uin: this.stack[0].author.id || this.bot.userId,
          content: this.children as any,
        },
      })
      this.children = []
      return
    }

    const session = this.bot.session(this.session)
    session.messageId = this.bot.parent
      ? '' + await this.bot.internal.sendGuildChannelMsg(this.guildId, this.channelId, this.children)
      : this.guildId
        ? '' + await this.bot.internal.sendGroupMsg(this.guildId, this.children)
        : '' + await this.bot.internal.sendPrivateMsg(this.channelId.slice(8), this.children)
    session.app.emit(session, 'send', session)
    this.results.push(session)
    this.children = []
  }

  private text(text: string) {
    this.children.push({ type: 'text', data: { text } })
  }

  async visit(element: segment) {
    let { type, attrs, children } = element
    if (type === 'text') {
      this.text(attrs.content)
    } else if (type === 'p') {
      await this.render(children)
      this.text('\n')
    } else if (type === 'at') {
      if (attrs.type === 'all') {
        this.children.push({ type: 'at', data: { qq: 'all' } })
      } else {
        this.children.push({ type: 'at', data: { qq: attrs.id } })
      }
    } else if (type === 'sharp') {
      if (attrs.id) this.text(attrs.id)
    } else if (type === 'a') {
      await this.render(children)
      if (attrs.href) this.text(` (${attrs.href}) `)
    } else if (['video', 'audio', 'image'].includes(type)) {
      if (type === 'audio') type = 'record'
      attrs = { ...attrs }
      attrs.file = attrs.url
      delete attrs.url
      const cap = /^data:([\w/-]+);base64,/.exec(attrs.file)
      if (cap) attrs.file = 'base64://' + attrs.file.slice(cap[0].length)
      this.children.push({ type, data: attrs })
    } else if (type === 'onebot:music') {
      this.children.push({ type: 'music', data: attrs })
    } else if (type === 'onebot:tts') {
      this.children.push({ type: 'tts', data: attrs })
    } else if (type === 'author') {
      Object.assign(this.stack[0].author, attrs)
    } else if (type === 'figure') {
      await this.flush()
      this.stack.unshift(new State('forward'))
      await this.render(children, true)
      this.stack.shift()
      await this.forward()
    } else if (type === 'quote') {
      await this.flush()
      this.children.push({ type: 'reply', data: attrs })
    } else if (type === 'message') {
      await this.flush()
      // qqguild does not support forward messages
      if (attrs.forward && !this.bot.parent) {
        this.stack.unshift(new State('forward'))
        await this.render(children, true)
        this.stack.shift()
        await this.forward()
      } else {
        if (attrs.userId) this.stack[0].author.id = attrs.userId
        if (attrs.nickname) this.stack[0].author.name = attrs.nickname
        await this.render(children)
        await this.flush()
      }
    } else {
      await this.render(children)
    }
  }
}