import { parseJsonOutput } from '@cbi/ai-core';
import { InterviewQuestionAi } from '@cbi/shared-types';

/**
 * Pulls the question text out of a streamed `interview.question` reply as it
 * arrives. The prompt asks for `{"question": "…"}`; the text inside the
 * string is released as soon as it is known (escapes decoded), so the room
 * can show it progressively. A reply that is not JSON is taken as plain
 * text. `finish` validates the whole reply like the non-streamed path does
 * and returns null when it is unusable (the caller falls back).
 */
export function createQuestionTextExtractor() {
  let raw = '';
  let mode: 'unknown' | 'json' | 'plain' = 'unknown';
  /** JSON mode: where the question string's content starts in `raw`, and how far it was read. */
  let valueStart = -1;
  let cursor = 0;
  let closed = false;
  let emitted = '';

  function readJson(): string {
    if (valueStart < 0) {
      const m = /"question"\s*:\s*"/.exec(raw);
      if (!m) return '';
      valueStart = m.index + m[0].length;
      cursor = valueStart;
    }
    let out = '';
    while (!closed && cursor < raw.length) {
      const ch = raw[cursor]!;
      if (ch === '"') {
        closed = true;
        break;
      }
      if (ch !== '\\') {
        out += ch;
        cursor++;
        continue;
      }
      // An escape: wait until it is complete.
      const next = raw[cursor + 1];
      if (next === undefined) break;
      if (next === 'u') {
        const hex = raw.slice(cursor + 2, cursor + 6);
        if (hex.length < 4) break;
        out += String.fromCharCode(Number.parseInt(hex, 16) || 0x20);
        cursor += 6;
        continue;
      }
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '' : next;
      cursor += 2;
    }
    return out;
  }

  return {
    /** Adds a streamed delta; returns the new question text it revealed (may be empty). */
    push(delta: string): string {
      raw += delta;
      if (mode === 'unknown') {
        const start = raw.replace(/^\s*(```(json)?\s*)?/i, '');
        if (!start) return '';
        mode = start.startsWith('{') ? 'json' : 'plain';
      }
      let text: string;
      if (mode === 'json') {
        text = readJson();
      } else {
        // Leading whitespace is held back until real text arrives.
        text = emitted ? delta : delta.replace(/^\s+/, '');
      }
      emitted += text;
      return text;
    },
    /** The text shown so far. */
    get shown() {
      return emitted;
    },
    /** The final question (validated), or null when the reply cannot be used. */
    finish(): string | null {
      let candidate: string | null = null;
      if (mode === 'json') {
        try {
          const parsed = InterviewQuestionAi.safeParse(parseJsonOutput(raw));
          candidate = parsed.success ? parsed.data.question : null;
        } catch {
          // Not valid JSON after all (cut off, or text around it): use what was streamed.
          candidate = closed ? emitted : null;
        }
      } else if (mode === 'plain') {
        candidate = raw.trim();
      }
      if (candidate === null) return null;
      const checked = InterviewQuestionAi.safeParse({ question: candidate });
      return checked.success ? checked.data.question : null;
    },
  };
}
