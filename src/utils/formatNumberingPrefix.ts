export function formatNumberingPrefix(
  index: number,
  numberingFormat: string
): string {
  if (numberingFormat.toLowerCase() === 'none') return '';
  const sample = numberingFormat.split(',')[0]?.trim() || numberingFormat;
  const match = sample.match(/\d+(\D*)/);
  const suffix = match && match[1].trim() ? match[1].trim() : '.';
  return `${index}${suffix} `;
}

