import { z } from 'zod';

import { defineTool, type JsonValue, type ToolDef } from '@247-agent/connector-sdk';

import type { AskArgs, SendArgs, SentMessage } from './bot.js';

const parseMode = z.enum(['HTML', 'Markdown', 'MarkdownV2']).optional();
const chatId = z.union([z.string(), z.number()]).optional();
/** A Telegram message id, or a Matrix event id. */
const replyTo = z.union([z.number().int(), z.string().min(1)]).optional();

/** What the ops need from either backend. */
export interface Bot {
  send(args: SendArgs): Promise<SentMessage>;
  ask(args: AskArgs): Promise<SentMessage & { options: string[] }>;
}

/** The ops this connector registers, in the order `tools/list` returns them. */
export function chatTools(b: Bot): ToolDef[] {
  return [
    defineTool({
      name: 'send',
      description:
        'Posts a message to the configured chat. Returns {message_id, chat_id}. reply_to quotes an earlier message (a Telegram message id, or a Matrix event id).',
      input: {
        text: z.string().min(1),
        parse_mode: parseMode,
        reply_to: replyTo,
        chat_id: chatId,
      },
      handler: async (args) => (await b.send(args)) as unknown as JsonValue,
    }),
    defineTool({
      name: 'ask',
      description:
        'Posts a question with its options (Approve/Reject unless given) as inline buttons on Telegram or keycap reactions on Matrix, and emits the answer as a chat.reply event carrying correlation_id. Returns {message_id, chat_id, options}.',
      input: {
        text: z.string().min(1),
        correlation_id: z.string().optional(),
        options: z.array(z.string().min(1)).min(1).max(20).optional(),
        parse_mode: parseMode,
        reply_to: replyTo,
        chat_id: chatId,
      },
      handler: async (args) => (await b.ask(args)) as unknown as JsonValue,
    }),
  ];
}
