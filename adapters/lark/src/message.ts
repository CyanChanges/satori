import { Context, Dict, h, MessageEncoder } from '@satorijs/core'
import { LarkBot } from './bot'
import { BaseResponse, Lark, MessageContent } from './types'
import { extractIdType } from './utils'

export class LarkMessageEncoder<C extends Context = Context> extends MessageEncoder<C, LarkBot<C>> {
  private quote: string | undefined
  private textContent = ''
  private richContent: MessageContent.RichText.Paragraph[] = []
  private card: MessageContent.Card | undefined
  private noteElements: MessageContent.Card.NoteElement.InnerElement[] | undefined
  private actionElements: MessageContent.Card.Element[] = []

  async post(data?: any) {
    try {
      let resp: BaseResponse & { data?: Lark.Message }
      if (this.quote) {
        resp = await this.bot.internal.replyImMessage(this.quote, data)
      } else {
        data.receive_id = this.channelId
        resp = await this.bot.internal?.createImMessage(data, {
          receive_id_type: extractIdType(this.channelId),
        })
      }
      const session = this.bot.session()
      session.messageId = resp.data.message_id
      session.timestamp = Number(resp.data.create_time) * 1000
      session.userId = resp.data.sender.id
      session.channelId = this.channelId
      session.guildId = this.guildId
      session.app.emit(session, 'send', session)
      this.results.push(session.event.message)
    } catch (e) {
      // try to extract error message from Lark API
      if (this.bot.http.isError(e)) {
        if (e.response?.data?.code) {
          const generalErrorMsg = `Check error code at https://open.larksuite.com/document/server-docs/getting-started/server-error-codes`
          e.message += ` (Lark error code ${e.response.data.code}: ${e.response.data.msg ?? generalErrorMsg})`
        }
      }
      this.errors.push(e)
    }
  }

  private flushText(button = false) {
    if ((this.textContent || !button) && this.actionElements.length) {
      this.card!.elements.push({ tag: 'action', actions: this.actionElements, layout: 'flow' })
      this.actionElements = []
    }
    if (this.textContent) {
      this.richContent.push([{ tag: 'md', text: this.textContent }])
      if (this.noteElements) {
        this.noteElements.push({ tag: 'plain_text', content: this.textContent })
      } else if (this.card) {
        this.card.elements.push({ tag: 'markdown', content: this.textContent })
      }
      this.textContent = ''
    }
  }

  async flush() {
    this.flushText()
    if (!this.card && !this.richContent.length) return

    if (this.card) {
      this.bot.logger.debug('card', JSON.stringify(this.card.elements))
      await this.post({
        msg_type: 'interactive',
        content: JSON.stringify({
          elements: this.card.elements,
        }),
      })
    } else {
      await this.post({
        msg_type: 'post',
        content: JSON.stringify({
          zh_cn: {
            content: this.richContent,
          },
        }),
      })
    }

    // reset cached content
    this.quote = undefined
    this.textContent = ''
    this.richContent = []
    this.card = undefined
  }

  async createImage(url: string) {
    const { filename, type, data } = await this.bot.assetsQuester.file(url)
    const payload = new FormData()
    payload.append('image', new Blob([data], { type }), filename)
    payload.append('image_type', 'message')
    const { data: { image_key } } = await this.bot.internal.createImImage(payload)
    return image_key
  }

  async sendFile(_type: 'video' | 'audio' | 'file', attrs: any) {
    const url = attrs.src || attrs.url
    const payload = new FormData()
    const { filename, type, data } = await this.bot.assetsQuester.file(url)
    payload.append('file', new Blob([data], { type }), filename)
    payload.append('file_name', filename)

    if (attrs.duration) {
      payload.append('duration', attrs.duration)
    }

    if (_type === 'audio') {
      // FIXME: only support opus
      payload.append('file_type', 'opus')
    } else if (_type === 'video') {
      // FIXME: only support mp4
      payload.append('file_type', 'mp4')
    } else {
      const ext = filename.split('.').pop()
      if (['doc', 'xls', 'ppt', 'pdf'].includes(ext)) {
        payload.append('file_type', ext)
      } else {
        payload.append('file_type', 'stream')
      }
    }

    const { data: { file_key } } = await this.bot.internal.createImFile(payload)
    await this.post({
      msg_type: _type === 'video' ? 'media' : _type,
      content: JSON.stringify({ file_key }),
    })
  }

  private createBehavior(attrs: Dict) {
    const behaviors: MessageContent.Card.ActionBehavior[] = []
    if (attrs.type === 'link') {
      behaviors.push({
        type: 'open_url',
        default_url: attrs.href,
      })
    } else if (attrs.type === 'input') {
      behaviors.push({
        type: 'callback',
        value: {
          _satori_type: 'command',
          content: attrs.text,
        },
      })
    } else if (attrs.type === 'action') {
      // TODO
    }
    return behaviors.length ? behaviors : undefined
  }

  async visit(element: h) {
    const { type, attrs, children } = element
    if (type === 'text') {
      this.textContent += attrs.content
    } else if (type === 'at') {
      if (attrs.type === 'all') {
        this.textContent += `<at user_id="all">${attrs.name ?? '所有人'}</at>`
      } else {
        this.textContent += `<at user_id="${attrs.id}">${attrs.name}</at>`
      }
    } else if (type === 'a') {
      await this.render(children)
      if (attrs.href) this.textContent += ` (${attrs.href})`
    } else if (type === 'p') {
      if (!this.textContent.endsWith('\n')) this.textContent += '\n'
      await this.render(children)
      if (!this.textContent.endsWith('\n')) this.textContent += '\n'
    } else if (type === 'br') {
      this.textContent += '\n'
    } else if (type === 'sharp') {
      // platform does not support sharp
    } else if (type === 'quote') {
      await this.flush()
      this.quote = attrs.id
    } else if (type === 'img' || type === 'image') {
      const image_key = await this.createImage(attrs.src || attrs.url)
      this.textContent += `![${attrs.alt ?? '图片'}](${image_key})`
      this.flushText()
      this.richContent.push([{ tag: 'img', image_key }])
    } else if (['video', 'audio', 'file'].includes(type)) {
      await this.flush()
      await this.sendFile(type as any, attrs)
    } else if (type === 'figure' || type === 'message') {
      await this.flush()
      await this.render(children, true)
    } else if (type === 'hr') {
      this.flushText()
      this.richContent.push([{ tag: 'hr' }])
      this.card?.elements.push({ tag: 'hr' })
    } else if (type === 'form') {
      this.flushText()
      const length = this.card?.elements.length
      await this.render(children)
      if (this.card?.elements.length > length) {
        const elements = this.card?.elements.slice(length)
        this.card.elements.push({
          tag: 'form',
          name: attrs.name || 'Form',
          elements,
        })
      }
    } else if (type === 'input') {
      this.flushText()
      this.card?.elements.push({
        tag: 'action',
        actions: [{
          tag: 'input',
          name: attrs.name,
          width: attrs.width,
          label: attrs.label && {
            tag: 'plain_text',
            content: attrs.label,
          },
          placeholder: attrs.placeholder && {
            tag: 'plain_text',
            content: attrs.placeholder,
          },
          behaviors: this.createBehavior(attrs),
        }],
      })
    } else if (type === 'button') {
      this.card ??= { elements: [] }
      this.flushText(true)
      await this.render(children)
      this.actionElements.push({
        tag: 'button',
        text: {
          tag: 'plain_text',
          content: this.textContent,
        },
        disabled: attrs.disabled,
        behaviors: this.createBehavior(attrs),
      })
      this.textContent = ''
    } else if (type === 'button-group') {
      this.flushText()
      await this.render(children)
      this.flushText()
    } else if (type.startsWith('lark:') || type.startsWith('feishu:')) {
      const tag = type.slice(type.split(':', 1)[0].length + 1)
      if (tag === 'share-chat') {
        await this.flush()
        await this.post({
          msg_type: 'share_chat',
          content: JSON.stringify({ chat_id: attrs.chatId }),
        })
      } else if (tag === 'share-user') {
        await this.flush()
        await this.post({
          msg_type: 'share_user',
          content: JSON.stringify({ user_id: attrs.userId }),
        })
      } else if (tag === 'system') {
        await this.flush()
        await this.render(children)
        await this.post({
          msg_type: 'system',
          content: JSON.stringify({
            type: 'divider',
            params: { divider_text: { text: this.textContent } },
            options: { need_rollup: attrs.needRollup },
          }),
        })
        this.textContent = ''
      } else if (tag === 'card') {
        await this.flush()
        this.card = {
          elements: [],
          header: attrs.title && {
            template: attrs.color,
            ud_icon: attrs.icon && {
              tag: 'standard_icon',
              token: attrs.icon,
            },
            title: {
              tag: 'plain_text',
              content: attrs.title,
            },
            subtitle: attrs.subtitle && {
              tag: 'plain_text',
              content: attrs.subtitle,
            },
          },
        }
        await this.render(children, true)
      } else if (tag === 'div') {
        this.flushText()
        await this.render(children)
        this.card?.elements.push({
          tag: 'markdown',
          text_align: attrs.align,
          text_size: attrs.size,
          content: this.textContent,
        })
        this.textContent = ''
      } else if (tag === 'note') {
        this.flushText()
        this.noteElements = []
        await this.render(children)
        this.flushText()
        this.card?.elements.push({
          tag: 'note',
          elements: this.noteElements,
        })
        this.noteElements = undefined
      } else if (tag === 'icon') {
        this.flushText()
        this.noteElements?.push({
          tag: 'standard_icon',
          token: attrs.token,
        })
      }
    } else {
      await this.render(children)
    }
  }
}

export { LarkMessageEncoder as FeishuMessageEncoder }
