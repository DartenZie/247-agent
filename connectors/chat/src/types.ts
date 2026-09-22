/** The slice of the Telegram Bot API types the connector reads (core.telegram.org/bots/api). */

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
  reply_to_message?: TgMessage;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  data?: string;
  /** Absent when the message is too old; otherwise at least `message_id` and `chat`. */
  message?: { message_id: number; chat: TgChat };
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  channel_post?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface TgInlineKeyboardButton {
  text: string;
  callback_data: string;
}

/** `from` as the events carry it. */
export interface From {
  id: number | null;
  name: string;
  username: string | null;
}

/** Payload of a `chat.message` event. */
export interface ChatMessagePayload {
  text: string;
  from: From;
  message_id: number;
  chat_id: string;
  date: string;
  /** The message this one replies to, when it does. */
  reply_to: number | null;
  [key: string]: unknown;
}

/** Payload of a `chat.reply` event: the answer to an `ask`. */
export interface ChatReplyPayload {
  correlation_id: string | null;
  /** True when the chosen option is the first one (`Approve` by default). */
  approved: boolean;
  /** The chosen option's label. */
  choice: string;
  /** The button label, or the typed text when the answer was a text reply. */
  text: string;
  from: From;
  /** The question's message id, as `ask` returned it. */
  message_id: number;
  chat_id: string;
  /** The answering message's id for a text reply; null for a button tap. */
  answer_message_id: number | null;
  [key: string]: unknown;
}
