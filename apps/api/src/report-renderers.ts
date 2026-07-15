import { deflateRawSync } from "node:zlib";
import type { ReportCell, ReportRow } from "./report-worker.js";

export const MAX_REPORT_ROWS = 10_000;
export const MAX_REPORT_BYTES = 50 * 1024 * 1024;

function xml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
}
function assertBounded(rows: ReportRow[]): void {
  if (rows.length > MAX_REPORT_ROWS) throw new Error(`Report exceeds the ${MAX_REPORT_ROWS}-row limit`);
}
function crc32(input: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of input) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(files: Array<{ name: string; body: Uint8Array }>): Uint8Array {
  const chunks: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name); const source = Buffer.from(file.body); const body = deflateRawSync(source, { level: 6 }); const crc = crc32(source);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 6); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(source.length, 22); local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, body);
    const header = Buffer.alloc(46); header.writeUInt32LE(0x02014b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(8, 10); header.writeUInt32LE(crc, 16); header.writeUInt32LE(body.length, 20); header.writeUInt32LE(source.length, 24); header.writeUInt16LE(name.length, 28); header.writeUInt32LE(offset, 42); central.push(header, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  const output = Buffer.concat([...chunks, directory, end]); if (output.length > MAX_REPORT_BYTES) throw new Error("Rendered report exceeds the output-size limit"); return output;
}
function columnName(index: number): string { let value = ""; for (let current = index + 1; current > 0; current = Math.floor((current - 1) / 26)) value = String.fromCharCode(65 + ((current - 1) % 26)) + value; return value; }
function xlsxCell(value: ReportCell, reference: string): string {
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${reference}"><v>${value}</v></c>`;
  if (typeof value === "boolean") return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}
export function renderXlsx(rows: ReportRow[]): Uint8Array {
  assertBounded(rows); const columns = [...new Set(rows.flatMap(Object.keys))]; const values: ReportCell[][] = [columns, ...rows.map((row) => columns.map((column) => row[column]))];
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${values.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, columnIndex) => xlsxCell(value, `${columnName(columnIndex)}${rowIndex + 1}`)).join("")}</row>`).join("")}</sheetData></worksheet>`;
  const encoder = new TextEncoder(); return zip([
    { name: "[Content_Types].xml", body: encoder.encode(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`) },
    { name: "_rels/.rels", body: encoder.encode(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { name: "xl/workbook.xml", body: encoder.encode(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Callora report" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
    { name: "xl/_rels/workbook.xml.rels", body: encoder.encode(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`) },
    { name: "xl/worksheets/sheet1.xml", body: encoder.encode(sheet) },
  ]);
}

function pdfText(value: unknown): string { return String(value ?? "").replace(/[^\x20-\x7e]/g, "?").replace(/([\\()])/g, "\\$1"); }
export function renderPdf(rows: ReportRow[]): Uint8Array {
  assertBounded(rows); const columns = [...new Set(rows.flatMap(Object.keys))]; const lines = [columns.join(" | "), ...rows.map((row) => columns.map((column) => row[column] ?? "").join(" | "))];
  const pages: string[][] = []; for (let index = 0; index < lines.length; index += 45) pages.push(lines.slice(index, index + 45)); if (pages.length === 0) pages.push(["No report data"]);
  const objects: string[] = []; const add = (value: string) => { objects.push(value); return objects.length; }; const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"); const pageIds: number[] = [];
  const pagesId = 2; add("placeholder");
  for (const page of pages) { const stream = `BT /F1 8 Tf 36 800 Td 0 -16 Td ${page.map((line) => `(${pdfText(line).slice(0, 150)}) Tj 0 -16 Td`).join(" ")} ET`; const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`); pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`)); }
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`; const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let output = "%PDF-1.4\n"; const offsets = [0]; objects.forEach((object, index) => { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${object}\nendobj\n`; }); const xref = Buffer.byteLength(output); output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer << /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const result = new TextEncoder().encode(output); if (result.length > MAX_REPORT_BYTES) throw new Error("Rendered report exceeds the output-size limit"); return result;
}
