import { z } from 'zod/v4';

const TYPE_LABELS: Record<string, string> = {
  string: 'text',
  number: 'number',
  int: 'integer',
  bigint: 'big integer',
  boolean: 'boolean',
  date: 'date',
  array: 'array',
  object: 'object',
  null: 'null',
  undefined: 'undefined',
};

function typeLabel(t: string): string {
  return TYPE_LABELS[t] ?? t;
}

z.config({
  localeError: (issue) => {
    switch (issue.code) {
      case 'invalid_type':
        if (issue.input === undefined || issue.input === null)
          return 'Required';
        return `Expected ${typeLabel(issue.expected)}`;
      case 'invalid_value':
        if (issue.values.length === 1)
          return `Must be ${String(issue.values[0])}`;
        return `Must be one of: ${issue.values.map(String).join(', ')}`;
      case 'too_small': {
        const adj = issue.inclusive ? 'at least' : 'more than';
        if (issue.origin === 'string')
          return `${adj} ${issue.minimum} characters`;
        if (issue.origin === 'array') return `${adj} ${issue.minimum} items`;
        return `Must be ${adj} ${issue.minimum}`;
      }
      case 'too_big': {
        const adj = issue.inclusive ? 'at most' : 'less than';
        if (issue.origin === 'string')
          return `${adj} ${issue.maximum} characters`;
        if (issue.origin === 'array') return `${adj} ${issue.maximum} items`;
        return `Must be ${adj} ${issue.maximum}`;
      }
      case 'invalid_format': {
        if (issue.format === 'email') return 'Invalid email';
        if (issue.format === 'url') return 'Invalid URL';
        if (issue.format === 'uuid') return 'Invalid UUID';
        if (issue.format === 'ip') return 'Invalid IP';
        return 'Invalid format';
      }
      case 'not_multiple_of':
        return `Must be a multiple of ${issue.divisor}`;
      case 'unrecognized_keys':
        return `Unknown fields: ${issue.keys.join(', ')}`;
      case 'invalid_union':
        return 'Does not match any valid format';
      case 'invalid_key':
        return 'Invalid key';
      case 'invalid_element':
        return 'Invalid element';
      default:
        return 'Invalid input';
    }
  },
});
