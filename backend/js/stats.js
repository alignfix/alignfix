export function getLinesStats(lines) {
  if (!lines || lines.length === 0) return 'No lines';
  let longest = 0;
  let shortest = Infinity;
  let totalLength = 0;

  let maxNumTokens = 0;
  let totalTokens = 0;

  lines.forEach(line => {
    const length = line.length;
    if (length > longest) longest = length;
    if (length < shortest) shortest = length;

    const numTokens = line.split(/\s+/).filter(Boolean).length;
    if (numTokens > maxNumTokens) maxNumTokens = numTokens;
    totalTokens += numTokens;
    totalLength += length;
  });

  const average = totalLength / lines.length;

  return {
    lines: lines.length,
    longest,
    shortest: (shortest === Infinity ? 0 : shortest),
    avg_length: average.toFixed(2),
    max_tokens: maxNumTokens,
    avg_tokens: (totalTokens / lines.length).toFixed(2),
    sample: lines.slice(0, 5)
  };
}