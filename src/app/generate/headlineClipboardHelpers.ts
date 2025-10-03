import type { HeadlineItem } from './types';

export const HEADLINE_CLIPBOARD_HEADERS = {
  title: 'Headline',
  sourcePublished: 'Source & Published',
  url: 'Original Link',
} as const;

export type HeadlineClipboardDataColumn = keyof typeof HEADLINE_CLIPBOARD_HEADERS;
export type HeadlineClipboardColumn = 'all' | HeadlineClipboardDataColumn;
export type HeadlineClipboardFormat = 'csv' | 'tsv';

type ColumnAccessor = (headline: HeadlineItem) => string;

type ColumnConfig = {
  header: string;
  accessor: ColumnAccessor;
};

const HEADLINE_CLIPBOARD_COLUMN_CONFIG: Record<HeadlineClipboardDataColumn, ColumnConfig> = {
  title: {
    header: HEADLINE_CLIPBOARD_HEADERS.title,
    accessor: (headline) =>
      sanitizeValue(headline.title || 'Untitled headline'),
  },
  sourcePublished: {
    header: HEADLINE_CLIPBOARD_HEADERS.sourcePublished,
    accessor: (headline) => {
      const pieces = [headline.source, headline.publishedAt]
        .map((value) => (value ? sanitizeValue(value) : ''))
        .filter(Boolean);

      return pieces.join(' | ');
    },
  },
  url: {
    header: HEADLINE_CLIPBOARD_HEADERS.url,
    accessor: (headline) => sanitizeValue(headline.url ?? ''),
  },
};

const DELIMITER_BY_FORMAT: Record<HeadlineClipboardFormat, string> = {
  csv: ',',
  tsv: '\t',
};

export function formatHeadlinesForClipboard(
  headlines: HeadlineItem[],
  {
    column,
    format,
  }: {
    column: HeadlineClipboardColumn;
    format: HeadlineClipboardFormat;
  }
): string {
  const dataColumns =
    column === 'all'
      ? (Object.keys(HEADLINE_CLIPBOARD_COLUMN_CONFIG) as HeadlineClipboardDataColumn[])
      : [column];

  if (dataColumns.length === 0) {
    return '';
  }

  const rows: string[][] = [];
  const headers = dataColumns.map(
    (dataColumn) => HEADLINE_CLIPBOARD_COLUMN_CONFIG[dataColumn].header
  );
  rows.push(headers);

  for (const headline of headlines) {
    const row = dataColumns.map((dataColumn) =>
      HEADLINE_CLIPBOARD_COLUMN_CONFIG[dataColumn].accessor(headline)
    );
    rows.push(row);
  }

  const delimiter = DELIMITER_BY_FORMAT[format];

  return rows
    .map((row) =>
      row
        .map((cell) =>
          format === 'csv' ? escapeForCsv(cell) : escapeForTsv(cell)
        )
        .join(delimiter)
    )
    .join('\n');
}

function sanitizeValue(value: string): string {
  return value.replace(/\r?\n|\r/g, ' ').trim();
}

function escapeForCsv(value: string): string {
  const needsQuotes = /[",\n]/.test(value);
  const escaped = value.replace(/"/g, '""');
  return needsQuotes ? `"${escaped}"` : escaped;
}

function escapeForTsv(value: string): string {
  return value.replace(/\t/g, ' ');
}
