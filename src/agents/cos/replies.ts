/**
 * Replies that COS's code sends by itself (not the model), in the language the user writes in.
 * The model replies in the user's language on its own (agents/cos/AGENTS.md).
 */
export type Lang = 'uk' | 'en';

/** The user's language from a message: Cyrillic means Ukrainian; no letters at all says nothing. */
export function detectLang(text: string): Lang | undefined {
  const cyrillic = text.match(/\p{Script=Cyrillic}/gu)?.length ?? 0;
  const latin = text.match(/\p{Script=Latin}/gu)?.length ?? 0;
  if (cyrillic === 0 && latin === 0) return undefined;
  return cyrillic >= latin ? 'uk' : 'en';
}

const REPLIES = {
  busy: {
    uk: (agents: string) => `Прийняв. Прочитаю, щойно завершиться поточний крок (працює агент ${agents}). /status — стан, /stop — скасувати.`,
    en: (agents: string) => `Got it. I'll read this when the current step finishes (the ${agents} agent is working). /status shows progress, /stop cancels.`,
  },
  stopped: {
    uk: (canceled: number) => `Зупинив. Скасовано завдань: ${canceled}. Замовлення збережено: напишіть, щоб продовжити, або /new, щоб почати спочатку.`,
    en: (canceled: number) => `Stopped. Canceled ${canceled} running task(s). The order is kept: write to continue, or /new to start over.`,
  },
  newOrder: {
    uk: () => 'Почав нове замовлення.',
    en: () => 'Started a new order.',
  },
  setupError: {
    uk: (detail: string) => `Помилка налаштування: ${detail}`,
    en: (detail: string) => `Setup error: ${detail}`,
  },
  lostMessage: {
    uk: () => 'Вибачте, під час перезапуску я втратив ваше останнє повідомлення. Надішліть його ще раз, будь ласка.',
    en: () => 'Sorry, I lost your last message while restarting. Please send it again.',
  },
  notFinished: {
    uk: (why: string) => `Вибачте, не вдалося обробити ваше повідомлення (${why}). Спробуйте ще раз, будь ласка.`,
    en: (why: string) => `Sorry, I could not finish handling your message (${why}). Please try again.`,
  },
} as const;

export type ReplyKey = keyof typeof REPLIES;

export function reply<K extends ReplyKey>(lang: Lang, key: K, ...args: Parameters<(typeof REPLIES)[K][Lang]>): string {
  const render = REPLIES[key][lang] as (...a: typeof args) => string;
  return render(...args);
}
