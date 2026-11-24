/**
 * @fileoverview The language of a request to Robert, decided in code (1.13.2): the model was
 * left to guess and sometimes answered an English question in German. Pure: mentions and links
 * are removed, then German and English signal words are counted.
 * @module src/chat-agent/pipeline/agent-language
 */

export type ReplyLanguage = 'de' | 'en';

// Function words that are frequent and nearly never shared ("was" is German here; English "was"
// rarely asks Robert anything without "what" or "who" beside it).
const words = (list: string) => new Set(list.trim().split(/\s+/));

const GERMAN = words(`
  und ist sind wir was wer wann wie wo warum bitte haben hat nicht ich du der die das den dem
  mit für bis noch schon vereinbart auch ein eine kannst gibt oder aber zu auf heute morgen
  welche welcher macht soll erstelle erstell mach schreib schreibe fass zusammen seite aufgabe
  aufgaben notizen diese dieses dieser unsere unser alle
`);

const ENGLISH = words(`
  the and is are we what who when how where why please have has not did do does to for of
  agreed can you a or but on today tomorrow which should get it this that these those my me
  pls plz write make create notes page task tasks summary summarize up from with all about new
`);

/** "de" or "en" when the request clearly shows one; null when it shows none or both equally. */
export function detectRequestLanguage(text: string): ReplyLanguage | null {
  const plain = text
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/@[\p{L}\p{N}._-]+/gu, ' ')
    .toLowerCase();

  let de = (plain.match(/[äöüß]/g) ?? []).length * 2;
  let en = 0;

  for (const word of plain.match(/[\p{L}]+/gu) ?? []) {
    // Both languages use these two: "what was decided in the plan".
    if (word === 'was' || word === 'in') continue;
    if (GERMAN.has(word)) de += 1;
    if (ENGLISH.has(word)) en += 1;
  }

  if (de === en) return null;
  return de > en ? 'de' : 'en';
}
