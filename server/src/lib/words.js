// "1 email" / "3 emails"; give the plural when it isn't just an added s:
// plural(2, 'entry', 'entries'). client/src/api.js#plural is the same rule.
export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many || `${one}s`}`;
}
