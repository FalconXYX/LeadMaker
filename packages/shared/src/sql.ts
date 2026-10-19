// A minimal parameterised SQL builder: values never enter the text. Fragments nest, and compile()
// numbers placeholders $1..$n for node-postgres / Prisma $queryRawUnsafe. `strings`/`values` have the
// same shape as Prisma.Sql, so `new Prisma.Sql(q.strings, q.values)` works too.
export class Sql {
  readonly strings: readonly string[];
  readonly values: readonly unknown[];

  constructor(strings: readonly string[], values: readonly unknown[]) {
    const s: string[] = [strings[0] ?? ''];
    const v: unknown[] = [];
    values.forEach((value, i) => {
      const next = strings[i + 1] ?? '';
      if (value instanceof Sql) {
        s[s.length - 1] += value.strings[0];
        value.values.forEach((inner, j) => {
          v.push(inner);
          s.push(value.strings[j + 1]);
        });
        s[s.length - 1] += next;
      } else {
        v.push(value);
        s.push(next);
      }
    });
    this.strings = s;
    this.values = v;
  }

  compile(): { text: string; values: unknown[] } {
    return { text: this.strings.reduce((acc, part, i) => `${acc}$${i}${part}`), values: [...this.values] };
  }
}

export function sql(strings: TemplateStringsArray | readonly string[], ...values: unknown[]): Sql {
  return new Sql(strings, values);
}

/** Trusted SQL text (identifiers, keywords). Never pass user input. */
export function raw(text: string): Sql {
  return new Sql([text], []);
}

export const empty = raw('');

export function join(parts: readonly Sql[], separator = ', '): Sql {
  if (!parts.length) return empty;
  return new Sql(['', ...Array(parts.length - 1).fill(separator), ''], parts);
}

const IDENT = /^[a-z_][a-z0-9_]*$/i;

/** A table alias or column name checked against a strict identifier pattern. */
export function ident(name: string): Sql {
  if (!IDENT.test(name)) throw new Error(`invalid SQL identifier: ${name}`);
  return raw(name);
}
