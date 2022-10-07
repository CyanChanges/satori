import { Dict, segment } from '@satorijs/satori'
import { BaseBot } from './base'

export function CQCode(type: string, attrs: Dict<string>) {
  if (type === 'text') return attrs.content
  let output = '[CQ:' + type
  for (const key in attrs) {
    if (attrs[key]) output += `,${key}=${segment.escape(attrs[key], true)}`
  }
  return output + ']'
}

export interface CQCode {
  type: string
  data: Dict<string>
  capture?: RegExpExecArray
}

export namespace CQCode {
  export function escape(source: any, inline = false) {
    const result = String(source)
      .replace(/&/g, '&amp;')
      .replace(/\[/g, '&#91;')
      .replace(/\]/g, '&#93;')
    return inline
      ? result.replace(/,/g, '&#44;').replace(/(\ud83c[\udf00-\udfff])|(\ud83d[\udc00-\ude4f\ude80-\udeff])|[\u2600-\u2B55]/g, ' ')
      : result
  }

  export function unescape(source: string) {
    return String(source)
      .replace(/&#91;/g, '[')
      .replace(/&#93;/g, ']')
      .replace(/&#44;/g, ',')
      .replace(/&amp;/g, '&')
  }

  export interface Message extends CQCode {
    type: 'message' | 'forward'
    children: CQCode[]
  }

  export function _render(elements: segment[], bot: BaseBot) {
    const result: Message[] = []
    let data = {}
    let buffer: Message = { type: 'message', data, children: [] }
    const flush = () => {
      if (buffer.children.length) result.push(buffer)
      buffer = { type: 'message', data, children: [] }
    }
    const render = (elements: segment[]) => {
      for (const element of elements) {
        let { type, attrs, children } = element
        if (type === 'text') {
          buffer.children.push({ type: 'text', data: { text: attrs.content } })
        } else if (type === 'at') {
          if (attrs.type === 'all') {
            buffer.children.push({ type: 'at', data: { qq: 'all' } })
          } else {
            buffer.children.push({ type: 'at', data: { qq: attrs.id } })
          }
        } else if (['video', 'audio', 'image'].includes(type)) {
          if (type === 'audio') type = 'record'
          attrs = { ...attrs }
          attrs.file = attrs.url
          delete attrs.url
          buffer.children.push({ type, data: attrs })
        } else if (type === 'quote') {
          flush()
          buffer.children.push({ type: 'reply', data: attrs })
        } else if (type === 'message') {
          flush()
          if ('quote' in attrs) {
            attrs = { ...attrs }
            delete attrs.quote
            buffer.children.push({ type: 'reply', data: attrs })
          } else if ('forward' in attrs && !bot.parent) {
            result.push({
              type: 'forward',
              data: attrs,
              children: _render(children, bot).map(({ data, children }) => ({
                type: 'node',
                data: data.id ? { id: data.id } : {
                  name: data.nickname || bot.nickname || bot.username,
                  uin: data.userId || bot.userId,
                  content: children as any,
                },
              })),
            })
          } else {
            data = attrs
            Object.assign(buffer.data, attrs)
            render(children)
            data = {}
          }
        }
      }
      flush()
    }
    render(elements)
    return result
  }

  export function render(source: string | segment, bot: BaseBot) {
    const elements = segment.normalize(source).children
    return _render(elements, bot)
  }

  const pattern = /\[CQ:(\w+)((,\w+=[^,\]]*)*)\]/

  export function from(source: string): CQCode {
    const capture = pattern.exec(source)
    if (!capture) return null
    const [, type, attrs] = capture
    const data: Dict<string> = {}
    attrs && attrs.slice(1).split(',').forEach((str) => {
      const index = str.indexOf('=')
      data[str.slice(0, index)] = unescape(str.slice(index + 1))
    })
    return { type, data, capture }
  }

  export function parse(source: string) {
    const elements: segment[] = []
    let result: ReturnType<typeof from>
    while ((result = from(source))) {
      const { type, data, capture } = result
      if (capture.index) {
        elements.push(segment('text', { content: unescape(source.slice(0, capture.index)) }))
      }
      elements.push(segment(type, data))
      source = source.slice(capture.index + capture[0].length)
    }
    if (source) elements.push(segment('text', { content: unescape(source) }))
    return elements
  }
}
