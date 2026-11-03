// Dependency-free synthetic PDFs for the link tests. They are deliberately small and use only
// the PDF features the extractor reads: page boxes, /Rotate, link annotations and destinations.
export type FixtureRect = [number, number, number, number];

export type FixtureDest = [page: number, kind: string, ...args: (number | null)[]];

export interface FixtureLink {
  rect: FixtureRect;
  /** An external link action. */
  url?: string;
  /** A named destination string, or an explicit destination array. */
  dest?: FixtureDest | string;
}

export interface FixturePage {
  mediaBox?: FixtureRect;
  cropBox?: FixtureRect;
  rotate?: number;
  links?: FixtureLink[];
}

export interface FixturePdf {
  pages: FixturePage[];
  /** Old-style catalog /Dests dictionary, the form pdf.js resolves with getDestination(). */
  namedDests?: Record<string, FixtureDest>;
}

/** A one-page PDF with one URI link and one in-document XYZ link (the pre-worker fixture). */
export function minimalLinksPdf(): Buffer {
  return buildPdf({
    pages: [
      {
        mediaBox: [0, 0, 200, 200],
        links: [
          { rect: [10, 20, 100, 40], url: 'https://example.com/' },
          { rect: [40, 120, 120, 140], dest: [1, 'XYZ', 0, 100, null] },
        ],
      },
    ],
  });
}

/** A complete PDF with pages but no link annotations. */
export function pdfWithoutLinks(pageCount = 1): Buffer {
  return buildPdf({
    pages: Array.from({ length: pageCount }, () => ({ mediaBox: [0, 0, 200, 200] as FixtureRect })),
  });
}

/** A PDF with `linksPerPage` links on every page, for cache/cancel/liveness/performance tests. */
export function manyLinksPdf(pageCount: number, linksPerPage = 2): Buffer {
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error('pageCount must be a positive integer');
  if (!Number.isInteger(linksPerPage) || linksPerPage < 1) throw new Error('linksPerPage must be a positive integer');
  return buildPdf({
    pages: Array.from({ length: pageCount }, (_, index) => {
      const page = index + 1;
      const links: FixtureLink[] = [];
      for (let j = 0; j < linksPerPage; j++) {
        const y = 20 + j * 30;
        links.push(
          j % 2 === 0
            ? { rect: [10, y, 100, y + 20], url: `https://example.com/${page}/${j}` }
            : { rect: [40, y, 120, y + 20], dest: [page, 'XYZ', 0, 100, null] },
        );
      }
      return { mediaBox: [0, 0, 612, 792] as FixtureRect, links };
    }),
  });
}

/** Cut the trailer off so the worker sees a file that is still being written. */
export function truncatePdf(data: Buffer, bytes = 8): Buffer {
  return data.subarray(0, Math.max(0, data.length - bytes));
}

export function buildPdf(fixture: FixturePdf): Buffer {
  if (!fixture.pages.length) throw new Error('a PDF needs at least one page');
  const pageObject = (page: number): number => 2 + page;
  let nextObject = 3 + fixture.pages.length;
  const annotationObjects = fixture.pages.map((page) => (page.links ?? []).map(() => nextObject++));
  const namedDests = fixture.namedDests && Object.keys(fixture.namedDests).length ? nextObject++ : undefined;
  const objectCount = nextObject;
  const objects: string[] = [];
  const destArray = (dest: FixtureDest): string => {
    const [page, kind, ...args] = dest;
    if (!Number.isInteger(page) || page < 1) throw new Error(`destination page must be 1-based: ${page}`);
    const tail = args.length ? ` ${args.map((value) => (value === null ? 'null' : number(value))).join(' ')}` : '';
    return `[${pageObject(page)} 0 R /${kind}${tail}]`;
  };

  objects[1] = `<< /Type /Catalog /Pages 2 0 R${namedDests ? ` /Dests ${namedDests} 0 R` : ''} >>`;
  objects[2] = `<< /Type /Pages /Kids [${fixture.pages.map((_, i) => `${pageObject(i + 1)} 0 R`).join(' ')}] /Count ${fixture.pages.length} >>`;

  fixture.pages.forEach((page, index) => {
    const pageNumber = index + 1;
    const media = page.mediaBox ?? [0, 0, 612, 792];
    const crop = page.cropBox ? ` /CropBox [${box(page.cropBox)}]` : '';
    const rotate = page.rotate ? ` /Rotate ${number(page.rotate)}` : '';
    const annotations = annotationObjects[index];
    const annots = annotations.length ? ` /Annots [${annotations.map((object) => `${object} 0 R`).join(' ')}]` : '';
    objects[pageObject(pageNumber)] = `<< /Type /Page /Parent 2 0 R /MediaBox [${box(media)}]${crop}${rotate}${annots} >>`;

    (page.links ?? []).forEach((link, linkIndex) => {
      const object = annotations[linkIndex];
      objects[object] = annotation(link, destArray);
    });
  });

  if (namedDests) {
    objects[namedDests] = `<< ${Object.entries(fixture.namedDests!)
      .map(([name, dest]) => `/${pdfName(name)} ${destArray(dest)}`)
      .join(' ')} >>`;
  }

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let object = 1; object < objectCount; object++) {
    const body = objects[object];
    if (!body) throw new Error(`missing PDF object ${object}`);
    offsets[object] = pdf.length;
    pdf += `${object} 0 obj\n${body}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objectCount}\n0000000000 65535 f \n`;
  for (let object = 1; object < objectCount; object++) {
    pdf += `${String(offsets[object]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objectCount} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

function annotation(link: FixtureLink, destArray: (dest: FixtureDest) => string): string {
  const parts = ['/Type /Annot', '/Subtype /Link', `/Rect [${box(link.rect)}]`, '/Border [0 0 0]'];
  if (link.url !== undefined) parts.push(`/A << /S /URI /URI (${pdfString(link.url)}) >>`);
  else if (typeof link.dest === 'string') parts.push(`/Dest (${pdfString(link.dest)})`);
  else if (link.dest) parts.push(`/Dest ${destArray(link.dest)}`);
  return `<< ${parts.join(' ')} >>`;
}

function box(rect: FixtureRect): string {
  return rect.map(number).join(' ');
}

function number(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`invalid PDF number: ${value}`);
  return String(value);
}

function pdfString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

function pdfName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, (char) => `#${char.charCodeAt(0).toString(16).padStart(2, '0')}`);
}
