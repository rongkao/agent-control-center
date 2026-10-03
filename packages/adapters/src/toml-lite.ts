/**
 * 容錯的 TOML 掃描器（P0 第三批審查：Codex config.toml 的環境變數名）。
 *
 * 只為“從 Codex 的配置裡找出點名要用的環境變數名”服務：按 TOML 語法讀出每一條賦值（表頭、點分鍵、內聯表、
 * 多行陣列、各種字串寫法都認），逐條交給 visit——同一個表裡重複的鍵也會各自回呼一次（Codex 自己會報錯，
 * 這裡寧可多認幾個名字，也不因為一處寫法問題把整個檔案丟掉）。不做型別校驗、不處理日期等標量的細節（按原文字串返回）。
 * 語法錯誤時丟擲 TomlSyntaxError（帶行號，不帶原文內容，避免把配置裡的值寫進日誌）。
 */

export type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue };

export class TomlSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`${message} (line ${line})`);
    this.name = 'TomlSyntaxError';
  }
}

const BARE_KEY = /[A-Za-z0-9_-]/;

/** 逐條讀出 TOML 裡的賦值：path 是完整的鍵路徑（表頭 + 點分鍵）。 */
export function scanToml(text: string, visit: (path: string[], value: TomlValue) => void): void {
  const s = text.replace(/^\uFEFF/, '');
  let i = 0;
  let table: string[] = [];

  const lineAt = (index: number) => s.slice(0, index).split('\n').length;
  const fail = (message: string): never => {
    throw new TomlSyntaxError(message, lineAt(i));
  };
  const skipSpaces = () => {
    while (s[i] === ' ' || s[i] === '\t') i += 1;
  };
  const skipComment = () => {
    if (s[i] === '#') while (i < s.length && s[i] !== '\n') i += 1;
  };
  /** 空白、註釋、換行（陣列、內聯表內部與檔案的空行）。 */
  const skipBlank = () => {
    for (;;) {
      skipSpaces();
      skipComment();
      if (s[i] === '\r' || s[i] === '\n') {
        i += 1;
        continue;
      }
      return;
    }
  };
  const expectLineEnd = () => {
    skipSpaces();
    skipComment();
    if (i < s.length && s[i] !== '\n' && s[i] !== '\r') fail('unexpected text after a value');
  };

  const escape = (): string => {
    const c = s[i];
    i += 1;
    switch (c) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'e':
        return '\u001b';
      case '"':
        return '"';
      case '\\':
        return '\\';
      case 'u':
      case 'U': {
        const length = c === 'u' ? 4 : 8;
        const hex = s.slice(i, i + length);
        if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== length) fail('invalid unicode escape');
        i += length;
        return String.fromCodePoint(Number.parseInt(hex, 16));
      }
      default:
        return fail('invalid escape');
    }
  };

  const basicString = (): string => {
    i += 1;
    let out = '';
    for (;;) {
      const c = s[i];
      if (c === undefined || c === '\n' || c === '\r') fail('unterminated string');
      if (c === '"') {
        i += 1;
        return out;
      }
      if (c === '\\') {
        i += 1;
        out += escape();
        continue;
      }
      out += c;
      i += 1;
    }
  };

  const literalString = (): string => {
    i += 1;
    const end = s.indexOf("'", i);
    const newline = s.slice(i, end === -1 ? undefined : end).search(/[\r\n]/);
    if (end === -1 || newline !== -1) fail('unterminated string');
    const out = s.slice(i, end);
    i = end + 1;
    return out;
  };

  const multilineBasic = (): string => {
    i += 3;
    if (s[i] === '\r' && s[i + 1] === '\n') i += 2;
    else if (s[i] === '\n') i += 1;
    let out = '';
    for (;;) {
      if (i >= s.length) fail('unterminated multi-line string');
      if (s.startsWith('"""', i)) {
        // 結束符前面允許再有一兩個引號（屬於內容）
        let quotes = 0;
        while (s[i + quotes] === '"') quotes += 1;
        out += '"'.repeat(Math.min(quotes - 3, 2));
        i += quotes;
        return out;
      }
      const c = s[i]!;
      if (c === '\\') {
        i += 1;
        if (s[i] === '\n' || s[i] === '\r' || s[i] === ' ' || s[i] === '\t') {
          // 行尾反斜槓：去掉換行和下一行開頭的空白
          while (s[i] === ' ' || s[i] === '\t' || s[i] === '\r' || s[i] === '\n') i += 1;
          continue;
        }
        out += escape();
        continue;
      }
      out += c;
      i += 1;
    }
  };

  const multilineLiteral = (): string => {
    i += 3;
    if (s[i] === '\r' && s[i + 1] === '\n') i += 2;
    else if (s[i] === '\n') i += 1;
    const end = s.indexOf("'''", i);
    if (end === -1) fail('unterminated multi-line string');
    // 結束符前面允許再有一兩個引號（屬於內容）
    let quotes = 0;
    while (s[end + quotes] === "'") quotes += 1;
    const out = s.slice(i, end) + "'".repeat(Math.min(quotes - 3, 2));
    i = end + quotes;
    return out;
  };

  const key = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      skipSpaces();
      if (s[i] === '"') parts.push(basicString());
      else if (s[i] === "'") parts.push(literalString());
      else {
        const start = i;
        while (i < s.length && BARE_KEY.test(s[i]!)) i += 1;
        if (i === start) fail('invalid key');
        parts.push(s.slice(start, i));
      }
      skipSpaces();
      if (s[i] === '.') {
        i += 1;
        continue;
      }
      return parts;
    }
  };

  const setPath = (target: { [key: string]: TomlValue }, path: string[], value: TomlValue) => {
    let node = target;
    for (const part of path.slice(0, -1)) {
      const next = node[part];
      if (next && typeof next === 'object' && !Array.isArray(next)) node = next;
      else {
        const created: { [key: string]: TomlValue } = {};
        node[part] = created;
        node = created;
      }
    }
    node[path.at(-1)!] = value;
  };

  const value = (): TomlValue => {
    const c = s[i];
    if (c === '"') return s.startsWith('"""', i) ? multilineBasic() : basicString();
    if (c === "'") return s.startsWith("'''", i) ? multilineLiteral() : literalString();
    if (c === '[') {
      i += 1;
      const items: TomlValue[] = [];
      for (;;) {
        skipBlank();
        if (s[i] === ']') {
          i += 1;
          return items;
        }
        items.push(value());
        skipBlank();
        if (s[i] === ',') {
          i += 1;
          continue;
        }
        if (s[i] === ']') {
          i += 1;
          return items;
        }
        fail('expected , or ] in array');
      }
    }
    if (c === '{') {
      i += 1;
      const table: { [key: string]: TomlValue } = {};
      for (;;) {
        // TOML 1.1 允許內聯表跨行、帶註釋：一併接受
        skipBlank();
        if (s[i] === '}') {
          i += 1;
          return table;
        }
        const path = key();
        if (s[i] !== '=') fail('expected = in inline table');
        i += 1;
        skipSpaces();
        setPath(table, path, value());
        skipBlank();
        if (s[i] === ',') {
          i += 1;
          continue;
        }
        if (s[i] === '}') {
          i += 1;
          return table;
        }
        fail('expected , or } in inline table');
      }
    }
    // 其餘標量（布林、數字、日期時間）：讀到分隔符為止
    const start = i;
    while (i < s.length && !/[,\]}\r\n#]/.test(s[i]!)) i += 1;
    const raw = s.slice(start, i).trim();
    if (!raw) fail('missing value');
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    // 數字、日期時間：這裡用不到它們的值，按原文返回
    return raw;
  };

  for (;;) {
    skipBlank();
    if (i >= s.length) return;
    if (s[i] === '[') {
      const arrayTable = s[i + 1] === '[';
      i += arrayTable ? 2 : 1;
      table = key();
      if (s[i] !== ']') fail('expected ] after table name');
      i += 1;
      if (arrayTable) {
        if (s[i] !== ']') fail('expected ]] after array table name');
        i += 1;
      }
      expectLineEnd();
      continue;
    }
    const path = key();
    if (s[i] !== '=') fail('expected = after key');
    i += 1;
    skipSpaces();
    visit([...table, ...path], value());
    expectLineEnd();
  }
}
