'use strict';

const PDFDocument = require('pdfkit');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, BorderStyle, AlignmentType, HeadingLevel, Header, Footer,
  ImageRun, PageNumber, PageOrientation, VerticalAlign,
} = require('docx');

// --- Shared helpers ------------------------------------------------------
function fmtDateTime(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString(); } catch { return ''; }
}
function fmtDate(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }); } catch { return ''; }
}
function meetingDateStr(m) {
  if (m.starts_at) {
    const s = fmtDate(m.starts_at);
    if (m.ends_at && new Date(m.ends_at).toDateString() !== new Date(m.starts_at).toDateString()) {
      return `${s} – ${fmtDate(m.ends_at)}`;
    }
    return s;
  }
  return fmtDate(m.created_at);
}
// pdfkit standard fonts are WinAnsi-encoded; drop characters they can't render
// (e.g. CJK) so generation never throws. DOCX handles full Unicode natively.
function pdfSafe(s) {
  return String(s == null ? '' : s).replace(/[^\x00-\xFF]/g, '?');
}
function truncate(s, n = 240) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Build the table column definitions + row data shared by both renderers.
function buildContent(meeting, signins) {
  const fields = JSON.parse(meeting.fields_json);
  const columns = [
    { header: '#', weight: 0.5 },
    ...fields.map((f) => ({ header: f.label, weight: 2 })),
    { header: 'Signed in at', weight: 1.8 },
  ];
  if (meeting.geofence_enabled) columns.push({ header: 'Location', weight: 1.4 });

  const rows = signins.map((s, i) => {
    const data = JSON.parse(s.data_json);
    const cells = [String(i + 1)];
    for (const f of fields) {
      let v = data[f.key];
      if (typeof v === 'boolean') v = v ? 'Yes' : 'No';
      cells.push(truncate(v == null ? '' : String(v)));
    }
    cells.push(fmtDateTime(s.created_at));
    if (meeting.geofence_enabled) {
      const within = s.within_geofence
        ? `In${s.distance_meters != null ? ' (' + Math.round(s.distance_meters) + 'm)' : ''}`
        : 'Outside';
      cells.push(s.flagged ? within + ' *' : within);
    }
    return cells;
  });

  const summary = {
    total: signins.length,
    withinGeofence: signins.filter((s) => s.within_geofence).length,
    flagged: signins.filter((s) => s.flagged).length,
  };
  return { columns, rows, summary, fields };
}

// Logo display size with max height 50px, width clamped to 180px.
function logoDims(branding) {
  const w = branding.logo_w || 100;
  const h = branding.logo_h || 50;
  let dh = 50;
  let dw = Math.round((w / h) * dh);
  if (dw > 180) { dw = 180; dh = Math.round((h / w) * dw); }
  return { w: dw, h: dh };
}

// =========================================================================
// PDF (pdfkit)
// =========================================================================
function generatePdf(meeting, signins, branding, stream, opts = {}) {
  const doc = new PDFDocument({
    size: 'A4', layout: 'landscape', margin: 36, bufferPages: true,
    info: { Title: `${meeting.title} — Sign-In Sheet`, Author: branding?.org_name || 'Meeting Signs' },
  });
  doc.pipe(stream);

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const top = doc.page.margins.top;

  // --- Branding header ---
  let textX = left;
  let logoBottom = top;
  if (branding && branding.logo_data) {
    try {
      doc.image(Buffer.from(branding.logo_data), left, top, { fit: [130, 56] });
      textX = left + 145;
      logoBottom = top + 56;
    } catch { /* ignore bad image */ }
  }
  doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(18)
    .text(pdfSafe(branding?.org_name || ''), textX, top, { width: right - textX });
  doc.font('Helvetica').fontSize(9).fillColor('#475569');
  if (branding?.address) doc.text(pdfSafe(branding.address), textX, doc.y, { width: right - textX });
  if (branding?.contact) doc.text(pdfSafe(branding.contact), textX, doc.y, { width: right - textX });
  doc.y = Math.max(doc.y, logoBottom) + 10;

  doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor('#cbd5e1').lineWidth(1).stroke();
  doc.moveDown(0.6);

  // --- Meeting block ---
  doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(15).text('Attendance / Sign-In Sheet', left, doc.y);
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(10).fillColor('#1e293b');
  doc.text('Meeting: ' + pdfSafe(meeting.title), { width: right - left });
  const venue = meeting.venue || meeting.location_name;
  if (venue) doc.text('Venue: ' + pdfSafe(venue));
  const dateStr = meetingDateStr(meeting);
  if (dateStr) doc.text('Date: ' + dateStr);
  if (opts.hostName) doc.text('Organizer / Host: ' + pdfSafe(opts.hostName));

  const { columns, rows, summary } = buildContent(meeting, signins);
  doc.fillColor('#475569').fontSize(9);
  let summaryLine = `Total attendees: ${summary.total}`;
  if (meeting.geofence_enabled) summaryLine += `   ·   Within geofence: ${summary.withinGeofence}`;
  if (summary.flagged) summaryLine += `   ·   Flagged (*): ${summary.flagged}`;
  summaryLine += `   ·   Generated: ${new Date().toLocaleString()}`;
  doc.text(summaryLine);
  doc.moveDown(0.6);

  // --- Table ---
  drawPdfTable(doc, columns, rows, left, right);

  // --- Footers (page numbers + footer text) ---
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const y = doc.page.height - 26;
    doc.font('Helvetica').fontSize(8).fillColor('#94a3b8');
    if (branding?.footer_text) {
      doc.text(pdfSafe(branding.footer_text), left, y, { width: right - left, align: 'left', lineBreak: false });
    }
    doc.text(`Page ${i + 1} of ${range.count}`, left, y, { width: right - left, align: 'right', lineBreak: false });
  }

  doc.end();
}

function drawPdfTable(doc, columns, rows, left, right) {
  const usableW = right - left;
  const totalWeight = columns.reduce((s, c) => s + c.weight, 0);
  const widths = columns.map((c) => (usableW * c.weight) / totalWeight);
  const pad = 4;
  const fs = 9;
  const bottomLimit = doc.page.height - doc.page.margins.bottom - 24;

  const measure = (cells) => {
    doc.font('Helvetica').fontSize(fs);
    let h = 0;
    for (let i = 0; i < cells.length; i++) {
      const hh = doc.heightOfString(String(cells[i] ?? ''), { width: widths[i] - 2 * pad });
      if (hh > h) h = hh;
    }
    return Math.max(h + 2 * pad, 16);
  };

  const render = (cells, isHeader, y) => {
    const h = measure(cells.map(pdfSafe));
    if (isHeader) doc.save().rect(left, y, usableW, h).fill('#1e293b').restore();
    let x = left;
    for (let i = 0; i < cells.length; i++) {
      doc.font(isHeader ? 'Helvetica-Bold' : 'Helvetica').fontSize(fs)
        .fillColor(isHeader ? '#ffffff' : '#0f172a')
        .text(pdfSafe(cells[i]), x + pad, y + pad, { width: widths[i] - 2 * pad });
      x += widths[i];
    }
    doc.strokeColor('#cbd5e1').lineWidth(0.5).rect(left, y, usableW, h).stroke();
    let bx = left;
    for (let i = 0; i < widths.length - 1; i++) { bx += widths[i]; doc.moveTo(bx, y).lineTo(bx, y + h).stroke(); }
    return h;
  };

  const headers = columns.map((c) => c.header);
  let y = doc.y;
  y += render(headers, true, y);
  for (const row of rows) {
    const h = measure(row.map(pdfSafe));
    if (y + h > bottomLimit) {
      doc.addPage();
      y = doc.page.margins.top;
      y += render(headers, true, y);
    }
    y += render(row, false, y);
  }
  doc.y = y;
}

// =========================================================================
// Word / DOCX
// =========================================================================
const BORDER = { style: BorderStyle.SINGLE, size: 2, color: 'CBD5E1' };
const TABLE_BORDERS = {
  top: BORDER, bottom: BORDER, left: BORDER, right: BORDER,
  insideHorizontal: BORDER, insideVertical: BORDER,
};

function cell(text, { header = false } = {}) {
  return new TableCell({
    verticalAlign: VerticalAlign.CENTER,
    shading: header ? { fill: '1E293B' } : undefined,
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
    children: [new Paragraph({
      children: [new TextRun({ text: String(text == null ? '' : text), bold: header, color: header ? 'FFFFFF' : '0F172A', size: header ? 18 : 18 })],
    })],
  });
}

function metaPara(label, value) {
  return new Paragraph({
    spacing: { after: 40 },
    children: [
      new TextRun({ text: label, bold: true, size: 20, color: '0F172A' }),
      new TextRun({ text: String(value || ''), size: 20, color: '1E293B' }),
    ],
  });
}

function buildDocxHeader(branding) {
  const kids = [];
  if (branding && branding.logo_data) {
    const dim = logoDims(branding);
    try {
      kids.push(new Paragraph({
        spacing: { after: 60 },
        children: [new ImageRun({
          type: branding.logo_mime === 'image/png' ? 'png' : 'jpg',
          data: Buffer.from(branding.logo_data),
          transformation: { width: dim.w, height: dim.h },
        })],
      }));
    } catch { /* ignore */ }
  }
  if (branding?.org_name) kids.push(new Paragraph({ children: [new TextRun({ text: branding.org_name, bold: true, size: 30, color: '0F172A' })] }));
  if (branding?.address) kids.push(new Paragraph({ children: [new TextRun({ text: branding.address, size: 16, color: '475569' })] }));
  if (branding?.contact) kids.push(new Paragraph({ children: [new TextRun({ text: branding.contact, size: 16, color: '475569' })] }));
  if (kids.length === 0) kids.push(new Paragraph({ text: '' }));
  return new Header({ children: kids });
}

async function generateDocx(meeting, signins, branding, opts = {}) {
  const { columns, rows, summary } = buildContent(meeting, signins);

  const headerRow = new TableRow({ tableHeader: true, children: columns.map((c) => cell(c.header, { header: true })) });
  const bodyRows = rows.map((r) => new TableRow({ children: r.map((c) => cell(c)) }));
  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: TABLE_BORDERS,
    rows: [headerRow, ...bodyRows],
  });

  const venue = meeting.venue || meeting.location_name;
  let summaryText = `Total attendees: ${summary.total}`;
  if (meeting.geofence_enabled) summaryText += `   ·   Within geofence: ${summary.withinGeofence}`;
  if (summary.flagged) summaryText += `   ·   Flagged (*): ${summary.flagged}`;

  const children = [
    new Paragraph({ text: 'Attendance / Sign-In Sheet', heading: HeadingLevel.HEADING_1, spacing: { after: 120 } }),
    metaPara('Meeting: ', meeting.title),
    ...(venue ? [metaPara('Venue: ', venue)] : []),
    ...(meetingDateStr(meeting) ? [metaPara('Date: ', meetingDateStr(meeting))] : []),
    ...(opts.hostName ? [metaPara('Organizer / Host: ', opts.hostName)] : []),
    new Paragraph({ spacing: { before: 60, after: 160 }, children: [new TextRun({ text: summaryText, size: 16, color: '475569' })] }),
    table,
    new Paragraph({ spacing: { before: 160 }, children: [new TextRun({ text: `Generated ${new Date().toLocaleString()} · Secured by Meeting Signs`, size: 14, color: '94A3B8' })] }),
  ];

  const footer = new Footer({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        ...(branding?.footer_text ? [new TextRun({ text: branding.footer_text + '   ', size: 16, color: '94A3B8' })] : []),
        new TextRun({ children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES], size: 16, color: '94A3B8' }),
      ],
    })],
  });

  const doc = new Document({
    creator: branding?.org_name || 'Meeting Signs',
    title: `${meeting.title} — Sign-In Sheet`,
    sections: [{
      properties: { page: { size: { orientation: PageOrientation.LANDSCAPE } } },
      headers: { default: buildDocxHeader(branding) },
      footers: { default: footer },
      children,
    }],
  });

  return Packer.toBuffer(doc);
}

module.exports = { generatePdf, generateDocx };
